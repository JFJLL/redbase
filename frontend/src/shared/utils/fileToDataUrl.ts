/**
 * Session-safe FileReader wrapper shared by every upload path (brand logo,
 * product images, style reference images).
 *
 * The AbortSignal must come from the same session scope as the follow-up
 * request (useAbortScope / notifyAuthReset): when the account switches or
 * logs out mid-read, FileReader.abort() is invoked and the promise rejects
 * with an AbortError, so no upload request can be issued for the previous
 * account. After the read completes the signal is checked once more before
 * resolving (legacy assertSessionEpoch semantics).
 */
export function fileToDataUrl(file: File, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const abortError = () => new DOMException("Aborted", "AbortError");
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const reader = new FileReader();
    const onAbort = () => {
      reader.abort();
    };
    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort);
    };
    reader.onload = () => {
      cleanup();
      // Re-check after the read finished: an abort that raced the load event
      // must still prevent the caller from continuing with the upload.
      if (signal?.aborted) {
        reject(abortError());
        return;
      }
      resolve(String(reader.result || ""));
    };
    reader.onerror = () => {
      cleanup();
      reject(new Error("读取图片文件失败"));
    };
    reader.onabort = () => {
      cleanup();
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    reader.readAsDataURL(file);
  });
}
