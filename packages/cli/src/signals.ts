export interface SignalSource {
  once(event: "SIGINT" | "SIGTERM", listener: () => void): this;
  removeListener(
    event: "SIGINT" | "SIGTERM",
    listener: () => void,
  ): this;
}

export interface InterruptHandle {
  readonly signal: AbortSignal;
  dispose(): void;
}

const INTERRUPT_EVENTS = ["SIGINT", "SIGTERM"] as const;

export function createInterruptHandle(
  source: SignalSource,
): InterruptHandle {
  const controller = new AbortController();
  const onInterrupt = (): void => controller.abort();
  for (const event of INTERRUPT_EVENTS) {
    source.once(event, onInterrupt);
  }
  return {
    signal: controller.signal,
    dispose(): void {
      for (const event of INTERRUPT_EVENTS) {
        source.removeListener(event, onInterrupt);
      }
    },
  };
}
