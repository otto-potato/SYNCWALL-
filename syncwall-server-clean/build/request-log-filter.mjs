const HIGH_FREQUENCY_REQUESTS = [
  /\bGET\s+\/api\/ping(?:[?\s]|$)/,
  /\bGET\s+\/api\/devices(?:[?\s]|$)/,
  /\bPOST\s+\/api\/devices\/heartbeat(?:[?\s]|$)/,
];

export function shouldSuppressRequestLog(message) {
  const plainMessage = message.replace(/\u001b\[[0-9;]*m/g, "");
  return HIGH_FREQUENCY_REQUESTS.some((pattern) =>
    pattern.test(plainMessage),
  );
}

let filterInstalled = false;

export function installRequestLogFilter() {
  if (filterInstalled) return;
  filterInstalled = true;

  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...args) => {
    const message =
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    if (shouldSuppressRequestLog(message)) {
      const callback = args.find((value) => typeof value === "function");
      if (callback) callback();
      return true;
    }
    return originalWrite(chunk, ...args);
  };
}
