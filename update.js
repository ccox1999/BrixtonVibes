import { activateRelease } from "./app-bootstrap.js?v=42";
const status = document.getElementById("updateStatus");
const retry = document.getElementById("retryUpdateBtn");
async function update() {
  retry.classList.add("hidden");
  status.textContent =
    "Downloading the current app. Your saved journeys stay on this device.";
  try {
    if (!navigator.serviceWorker) {
      location.replace("./?release=42");
      return;
    }
    await activateRelease(navigator.serviceWorker);
    status.textContent = "Update ready. Opening the app…";
    location.replace("./?release=42");
  } catch (error) {
    status.textContent = error.message;
    retry.classList.remove("hidden");
  }
}
retry.addEventListener("click", update);
update();
