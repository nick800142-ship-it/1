import { useLayoutEffect, useRef } from "react";
import { formatNumberInput, stripNumberGrouping } from "@/lib/numberFormat";

type Props = Omit<React.InputHTMLAttributes<HTMLInputElement>, "type" | "value" | "onChange"> & {
  value: string | number;
  onValueChange: (rawValue: string) => void;
  allowNegative?: boolean;
};

export function FormattedNumberInput({ value, onValueChange, allowNegative = false, inputMode = "decimal", ...props }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const caretFromEnd = useRef<number | null>(null);
  const formatted = formatNumberInput(value);

  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input || caretFromEnd.current === null) return;
    const position = Math.max(0, input.value.length - caretFromEnd.current);
    input.setSelectionRange(position, position);
    caretFromEnd.current = null;
  }, [formatted]);

  return (
    <input
      {...props}
      ref={inputRef}
      type="text"
      inputMode={inputMode}
      value={formatted}
      onChange={(event) => {
        const input = event.currentTarget;
        caretFromEnd.current = input.value.length - (input.selectionStart ?? input.value.length);
        let raw = stripNumberGrouping(input.value).replace(allowNegative ? /[^\d.-]/g : /[^\d.]/g, "");
        const decimalIndex = raw.indexOf(".");
        if (decimalIndex >= 0) raw = `${raw.slice(0, decimalIndex + 1)}${raw.slice(decimalIndex + 1).replace(/\./g, "")}`;
        if (allowNegative) raw = `${raw.startsWith("-") ? "-" : ""}${raw.replace(/-/g, "")}`;
        onValueChange(raw);
      }}
    />
  );
}
