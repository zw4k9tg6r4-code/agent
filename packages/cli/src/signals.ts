export interface SignalSource {
  once(event: "SIGINT", listener: () => void): this;
  removeListener(event: "SIGINT", listener: () => void): this;
}

export interface InterruptHandle {
  readonly signal: AbortSignal;
  dispose(): void;
}

export function createInterruptHandle(
  source: SignalSource,
): InterruptHandle {
  const controller = new AbortController();
  const onInterrupt = (): void => controller.abort();
  source.once("SIGINT", onInterrupt);
  return {
    signal: controller.signal,
    dispose(): void {
      source.removeListener("SIGINT", onInterrupt);
    },
  };
}
