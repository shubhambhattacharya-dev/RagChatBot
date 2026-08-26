const originalWarn = console.warn;
const originalError = console.error;

console.warn = (...args: unknown[]) => {
  const message = args[0];
  if (
    typeof message === "string" &&
    (message.includes("Gemini embedding rate-limited") ||
      message.includes("Gemini embedding temporary failure") ||
      message.includes("Embedding generation failed"))
  ) {
    return;
  }
  originalWarn.apply(console, args);
};

console.error = (...args: unknown[]) => {
  const message = args[0];
  if (
    typeof message === "string" &&
    message.includes("Embedding generation failed")
  ) {
    return;
  }
  originalError.apply(console, args);
};
