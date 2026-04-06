'use client';

import * as React from 'react';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

interface JsonTextareaProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  rows?: number;
}

export function JsonTextarea({
  value,
  onChange,
  placeholder = '{}',
  className,
  rows = 4,
}: JsonTextareaProps) {
  const [error, setError] = React.useState<string | null>(null);
  const [localValue, setLocalValue] = React.useState(value);

  React.useEffect(() => {
    setLocalValue(value);
  }, [value]);

  const handleBlur = () => {
    if (!localValue.trim()) {
      setError(null);
      onChange('{}');
      setLocalValue('{}');
      return;
    }

    try {
      const parsed = JSON.parse(localValue);
      const formatted = JSON.stringify(parsed, null, 2);
      setError(null);
      onChange(formatted);
      setLocalValue(formatted);
    } catch (e) {
      setError('Invalid JSON');
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setLocalValue(e.target.value);
    setError(null);
  };

  return (
    <div className="space-y-1">
      <Textarea
        value={localValue}
        onChange={handleChange}
        onBlur={handleBlur}
        placeholder={placeholder}
        rows={rows}
        className={cn(
          'font-mono text-sm',
          error && 'border-destructive',
          className
        )}
      />
      {error && (
        <p className="text-xs text-destructive">{error}</p>
      )}
    </div>
  );
}
