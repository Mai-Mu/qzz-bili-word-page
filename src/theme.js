const toggle = document.getElementById("theme-toggle");
const options = document.getElementById("theme-options");
const swatches = [...options.querySelectorAll(".theme-swatch")];
const darkPreference = matchMedia("(prefers-color-scheme: dark)");
let chosenTheme;

function applyTheme(theme) {
  const selected = swatches.find(swatch => swatch.dataset.theme === theme);
  if (!selected) return false;

  document.documentElement.dataset.theme = theme;
  for (const swatch of swatches) {
    swatch.setAttribute("aria-pressed", String(swatch === selected));
  }
  const label = `切换主题 · ${selected.title}`;
  toggle.title = label;
  toggle.setAttribute("aria-label", label);
  return true;
}

function applySystemTheme() {
  applyTheme(darkPreference.matches ? "midnight" : "forest");
}

function positionOptions() {
  const bounds = toggle.getBoundingClientRect();
  options.style.top = `${bounds.bottom + 8}px`;
  options.style.right = `${Math.max(8, document.documentElement.clientWidth - bounds.right)}px`;
}

options.addEventListener("beforetoggle", event => {
  if (event.newState === "open") positionOptions();
});

window.addEventListener("resize", () => {
  if (options.matches(":popover-open")) positionOptions();
});

for (const swatch of swatches) {
  swatch.addEventListener("click", () => {
    chosenTheme = swatch.dataset.theme;
    applyTheme(chosenTheme);
    options.hidePopover();
    toggle.focus({ preventScroll: true });
    chrome.storage.local.set({ theme: chosenTheme }).catch(console.error);
  });
}

applySystemTheme();
darkPreference.addEventListener("change", () => {
  if (!chosenTheme) applySystemTheme();
});
chrome.storage.local.get("theme").then(({ theme }) => {
  if (!chosenTheme && applyTheme(theme)) chosenTheme = theme;
}).catch(console.error);
