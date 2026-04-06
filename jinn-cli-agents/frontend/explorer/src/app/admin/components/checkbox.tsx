'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';
import { Check } from 'lucide-react';

interface CheckboxProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  id?: string;
  className?: string;
  disabled?: boolean;
}

export function Checkbox({
  checked,
  onCheckedChange,
  id,
  className,
  disabled = false,
}: CheckboxProps) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      id={id}
      disabled={disabled}
      onClick={() => !disabled && onCheckedChange(!checked)}
      className={cn(
        'peer h-4 w-4 shrink-0 rounded-sm border border-primary shadow-xs',
        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
        'disabled:cursor-not-allowed disabled:opacity-50',
        checked && 'bg-primary text-primary-foreground',
        className
      )}
    >
      {checked && <Check className="h-3 w-3" />}
    </button>
  );
}
