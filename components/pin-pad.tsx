"use client";

import { Button } from "@/components/ui";

interface PinPadProps {
  value: string;
  onChange: (next: string) => void;
  /** Called by the check key when value has at least `minLength` digits. */
  onSubmit?: () => void;
  minLength?: number;
  maxLength?: number;
  disabled?: boolean;
  /** Hides the dots row (when the caller shows its own). */
  compact?: boolean;
}

export function PinDots({ value, maxLength = 6 }: { value: string; maxLength?: number }) {
  return (
    <div role="img" aria-label={`${value.length} digit${value.length === 1 ? "" : "s"} entered`} className="flex justify-center gap-3">
      {Array.from({ length: maxLength }, (_, i) => (
        <span
          key={i}
          aria-hidden
          className={`size-4 rounded-full border-2 ${i < value.length ? "border-brass bg-brass" : "border-muted bg-transparent"}`}
        />
      ))}
    </div>
  );
}

export function PinPad({ value, onChange, onSubmit, minLength = 4, maxLength = 6, disabled, compact }: PinPadProps) {
  const press = (d: string) => {
    if (value.length < maxLength) onChange(value + d);
  };
  const key = "h-16 text-2xl font-semibold tabular-nums";
  return (
    <div className="mx-auto flex w-full max-w-xs flex-col gap-4">
      {compact ? null : <PinDots value={value} maxLength={maxLength} />}
      <div className="grid grid-cols-3 gap-3">
        {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => (
          <Button key={d} className={key} disabled={disabled} onClick={() => press(d)}>
            {d}
          </Button>
        ))}
        <Button
          className={key}
          disabled={disabled || value.length === 0}
          onClick={() => onChange(value.slice(0, -1))}
          aria-label="Delete last digit"
        >
          ⌫
        </Button>
        <Button className={key} disabled={disabled} onClick={() => press("0")}>
          0
        </Button>
        {onSubmit ? (
          <Button
            variant="primary"
            className={key}
            disabled={disabled || value.length < minLength}
            onClick={onSubmit}
            aria-label="Enter"
          >
            ✓
          </Button>
        ) : (
          <span aria-hidden />
        )}
      </div>
    </div>
  );
}
