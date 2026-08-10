'use client';

import { useId, useMemo, useState } from 'react';
import { Search } from 'lucide-react';

export type SearchSuggestion = {
  value: string;
  label?: string;
  detail?: string;
};

export function SearchSuggest({
  value,
  onChange,
  placeholder,
  suggestions,
  className = '',
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  suggestions: SearchSuggestion[];
  className?: string;
}) {
  const id = useId();
  const [focused, setFocused] = useState(false);
  const [active, setActive] = useState(0);
  const shown = useMemo(() => {
    const query = value.trim().toLowerCase();
    if (!query) return [];
    const seen = new Set<string>();
    return suggestions
      .filter((item) => `${item.value} ${item.label ?? ''} ${item.detail ?? ''}`.toLowerCase().includes(query))
      .filter((item) => {
        const key = `${item.value}|${item.label ?? ''}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, 8);
  }, [suggestions, value]);
  const open = focused && shown.length > 0;
  const choose = (item: SearchSuggestion) => {
    onChange(item.value);
    setFocused(false);
  };

  return (
    <div className={`relative ${className}`}>
      <label className="relative block">
        <span className="sr-only">搜尋</span>
        <Search className="absolute left-4 top-1/2 size-4 -translate-y-1/2 text-slate-500" />
        <input
          type="search"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={`${id}-listbox`}
          value={value}
          onFocus={() => setFocused(true)}
          onBlur={() => window.setTimeout(() => setFocused(false), 120)}
          onChange={(event) => {
            onChange(event.target.value);
            setActive(0);
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.keyCode === 229 || !open) return;
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              setActive((current) => Math.min(current + 1, shown.length - 1));
            } else if (event.key === 'ArrowUp') {
              event.preventDefault();
              setActive((current) => Math.max(current - 1, 0));
            } else if (event.key === 'Enter') {
              event.preventDefault();
              choose(shown[active]);
            } else if (event.key === 'Escape') {
              setFocused(false);
            }
          }}
          placeholder={placeholder}
          className="w-full rounded-xl border border-slate-700 bg-slate-900 py-3 pl-11 pr-4 text-sm outline-none transition focus:border-amber-400"
        />
      </label>
      {open && (
        <div id={`${id}-listbox`} role="listbox" className="absolute z-40 mt-2 max-h-72 w-full overflow-y-auto rounded-xl border border-slate-700 bg-slate-950 p-1 shadow-2xl shadow-black/40">
          {shown.map((item, index) => (
            <button
              key={`${item.value}-${item.label ?? ''}-${index}`}
              type="button"
              role="option"
              aria-selected={index === active}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(item)}
              onMouseEnter={() => setActive(index)}
              className={`flex w-full min-w-0 items-center justify-between gap-3 rounded-lg px-3 py-3 text-left text-sm ${index === active ? 'bg-amber-400 text-slate-950' : 'text-slate-200 hover:bg-slate-800'}`}
            >
              <span className="min-w-0"><span className="block truncate font-semibold">{item.label ?? item.value}</span>{item.label && item.value !== item.label && <span className={`block truncate text-xs ${index === active ? 'text-slate-800' : 'text-slate-500'}`}>{item.value}</span>}</span>
              {item.detail && <span className={`shrink-0 text-xs ${index === active ? 'text-slate-800' : 'text-slate-500'}`}>{item.detail}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
