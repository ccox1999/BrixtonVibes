// No app registration, credentials, cloud backend, or laptop. The operating
// system offers the already-installed OneDrive app / Files provider as a target.
// A successful handoff is NOT proof that OneDrive finished uploading the file.
export class NativeRecordingSave {
  constructor({
    navigatorRef = globalThis.navigator,
    onStatus = () => {},
  } = {}) {
    this.navigator = navigatorRef;
    this.onStatus = onStatus;
    this.file = null;
    this.recording = false;
    this.busy = false;
  }
  setRecording(value) {
    this.recording = !!value;
  }
  prepare(blob, filename) {
    if (
      !(blob instanceof Blob) ||
      !blob.size ||
      !/^victoria-recording-[A-Za-z0-9_-]+\.json$/.test(filename)
    ) {
      throw new Error("A complete recording file is required");
    }
    this.file = new File([blob], filename, { type: "application/json" });
    // Some browsers accept text files but do not advertise application/json.
    // Keep the actual .json name and bytes; only the transport MIME changes.
    if (!this.supported()) {
      const text = new File([blob], filename, { type: "text/plain" });
      try {
        if (this.navigator?.canShare?.({ files: [text] })) this.file = text;
      } catch {}
    }
    this.onStatus({ state: "ready", supported: this.supported(), filename });
    return this.supported();
  }
  supported() {
    try {
      return (
        !!this.file &&
        typeof this.navigator?.share === "function" &&
        this.navigator?.canShare?.({ files: [this.file] }) === true
      );
    } catch {
      return false;
    }
  }
  share() {
    if (this.recording)
      return Promise.reject(
        new Error("Finish recording before saving to OneDrive"),
      );
    if (this.busy)
      return Promise.reject(new Error("The save screen is already open"));
    if (!this.supported())
      return Promise.reject(
        new Error(
          "File sharing is unavailable in this browser. Open the app in iPhone Safari with OneDrive installed.",
        ),
      );
    this.busy = true;
    this.onStatus({ state: "sharing" });
    let operation;
    try {
      // MUST run directly inside the tap: no IndexedDB read, fetch, or awaited
      // preparation before this call. iOS requires transient user activation.
      operation = this.navigator.share({ files: [this.file] });
    } catch (error) {
      operation = Promise.reject(error);
    }
    return Promise.resolve(operation)
      .then(
        () => {
          this.onStatus({ state: "handed-off" });
          return { handedOff: true, cloudUploadConfirmed: false };
        },
        (error) => {
          this.onStatus({
            state: error?.name === "AbortError" ? "cancelled" : "failed",
            error,
          });
          if (error?.name === "AbortError")
            return { handedOff: false, cancelled: true };
          throw error;
        },
      )
      .finally(() => {
        this.busy = false;
      });
  }
}
