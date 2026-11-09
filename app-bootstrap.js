// Start the app only after a coherent offline shell is ready. This file and
// the CSS use a release URL, so a legacy worker cannot serve their old copies.
const RELEASE = "43";
const workerURL = new URL(`./sw.js?v=${RELEASE}`, location.href).href;
const workerContainer = navigator.serviceWorker;
let appStarted = false;
let reloadStarted = false;
let updatePending = false;

export async function activateRelease(container, timeoutMs = 20000) {
  const registration = await container.register(workerURL, {
    updateViaCache: "none",
  });
  const activeMatches = () =>
    registration.active?.scriptURL === workerURL &&
    registration.active.state === "activated";
  if (activeMatches()) return registration;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () =>
        finish(
          new Error(
            "The app update could not finish downloading. Your recordings have not been changed.",
          ),
        ),
      timeoutMs,
    );
    const cleanup = [];
    function finish(error) {
      clearTimeout(timer);
      for (const remove of cleanup) remove();
      error ? reject(error) : resolve();
    }
    function watch(worker) {
      if (!worker) return;
      const check = () => {
        if (activeMatches()) finish();
        else if (worker.state === "redundant")
          finish(
            new Error(
              "The app update was interrupted. Your recordings have not been changed.",
            ),
          );
      };
      worker.addEventListener("statechange", check);
      cleanup.push(() => worker.removeEventListener("statechange", check));
      check();
    }
    const found = () => watch(registration.installing);
    registration.addEventListener("updatefound", found);
    cleanup.push(() => registration.removeEventListener("updatefound", found));
    const changed = () => {
      if (activeMatches()) finish();
    };
    container.addEventListener("controllerchange", changed);
    cleanup.push(() =>
      container.removeEventListener("controllerchange", changed),
    );
    watch(
      registration.installing || registration.waiting || registration.active,
    );
  });
  return registration;
}

function blocked() {
  const state = window.motionLab?.state;
  return !!(
    state?.recording ||
    state?.finishing ||
    state?.memoryUnsaved ||
    state?.nativeSave?.busy
  );
}
function showPendingUpdate() {
  const notice = document.getElementById("updateNotice");
  if (!notice) return;
  notice.classList.toggle("hidden", !updatePending || blocked());
  document.getElementById("applyUpdateBtn").disabled = blocked();
}
function applyUpdate(explicit = false) {
  if (!updatePending || blocked() || reloadStarted) return;
  const state = window.motionLab?.state;
  if (state?.data?.length && (!explicit || !state.latestRecordingDurable)) {
    showPendingUpdate();
    return;
  }
  reloadStarted = true;
  location.reload();
}

workerContainer?.addEventListener("controllerchange", () => {
  if (!appStarted) return;
  updatePending = true;
  applyUpdate();
  showPendingUpdate();
});
window.addEventListener("brixton:idle", () => {
  applyUpdate();
  showPendingUpdate();
});
document
  .getElementById("applyUpdateBtn")
  ?.addEventListener("click", () => applyUpdate(true));

async function start() {
  try {
    if (workerContainer && window.isSecureContext)
      await activateRelease(workerContainer);
  } catch (error) {
    // A network outage must not prevent a downloaded app from recording.
    console.info("[app update]", error.message);
  }
  await import(`./app.js?v=${RELEASE}`);
  appStarted = true;
}

// The dedicated migration page shares the updater but never starts sensors.
if (!document.documentElement.hasAttribute("data-app-updater"))
  start().catch((error) => {
    const warning = document.getElementById("sensorWarning");
    if (warning)
      warning.textContent = `The app could not load: ${error.message}. Reopen while online; saved recordings are unchanged.`;
  });
