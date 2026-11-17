export function createMediaSession(player, canControl) {
  const session = navigator.mediaSession;
  if (!session || typeof MediaMetadata !== 'function') return () => {};

  let current;
  let publishedItem;
  let publishedPart;
  let publishedArtwork;
  let playbackState;
  let positionState;
  let canGoBack;
  let canGoForward;

  function setAction(action, handler) {
    try {
      session.setActionHandler(action, handler && ((details) => {
        if (canControl()) handler(details);
      }));
    } catch {
      // Media actions supported by the browser can vary by platform.
    }
  }

  const pauseAvailable = () => current?.status === 'playing' || current?.status === 'loading';
  setAction('play', () => {
    if (current?.item && !pauseAvailable()) void player.toggle();
  });
  setAction('pause', () => {
    if (pauseAvailable()) void player.toggle();
  });
  setAction('seekto', ({ seekTime }) => player.seek(seekTime));
  setAction('seekbackward', ({ seekOffset = 10 }) => player.seek(current.position - seekOffset));
  setAction('seekforward', ({ seekOffset = 10 }) => player.seek(current.position + seekOffset));

  function updatePosition({ duration, position, status }, item, part) {
    if (typeof session.setPositionState !== 'function') return;
    if (!item || status === 'loading' || !Number.isFinite(duration) || duration <= 0 || !Number.isFinite(position)) {
      if (positionState) session.setPositionState();
      positionState = undefined;
      return;
    }

    const now = performance.now();
    const clampedPosition = Math.max(0, Math.min(position, duration));
    if (positionState && positionState.item === item && positionState.part === part
        && positionState.duration === duration && positionState.status === status) {
      const elapsed = status === 'playing' ? (now - positionState.time) / 1000 : 0;
      const predicted = Math.min(duration, positionState.position + elapsed);
      if (Math.abs(clampedPosition - predicted) < 0.5) return;
    }
    session.setPositionState({ duration, position: clampedPosition, playbackRate: 1 });
    positionState = { item, part, duration, status, position: clampedPosition, time: now };
  }

  return function update(state, artwork = '') {
    current = state;
    const { item, part, parts, status, canPrevious, canNext } = state;
    if (item !== publishedItem || part !== publishedPart || artwork !== publishedArtwork) {
      const partNumber = parts.length > 1 && part?.page ? ` · P${part.page}` : '';
      session.metadata = item ? new MediaMetadata({
        title: `${item.title}${partNumber}`,
        artist: item.author || '',
        artwork: artwork ? [{ src: artwork }] : [],
      }) : null;
      publishedItem = item;
      publishedPart = part;
      publishedArtwork = artwork;
    }

    const nextState = status === 'playing' ? 'playing' : item ? 'paused' : 'none';
    if (playbackState !== nextState) {
      session.playbackState = nextState;
      playbackState = nextState;
    }
    if (canPrevious !== canGoBack) {
      setAction('previoustrack', canPrevious ? () => { void player.previous(); } : null);
      canGoBack = canPrevious;
    }
    if (canNext !== canGoForward) {
      setAction('nexttrack', canNext ? () => { void player.next(); } : null);
      canGoForward = canNext;
    }
    updatePosition(state, item, part);
  };
}
