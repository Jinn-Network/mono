'use client';

import * as React from 'react';
import { Input } from '@/components/ui/input';

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

interface SlugInputProps {
  value: string;
  onChange: (value: string) => void;
  sourceValue?: string;
  placeholder?: string;
  className?: string;
}

export function SlugInput({
  value,
  onChange,
  sourceValue,
  placeholder = 'auto-generated-slug',
  className,
}: SlugInputProps) {
  const [manuallyEdited, setManuallyEdited] = React.useState(false);

  React.useEffect(() => {
    if (!manuallyEdited && sourceValue) {
      onChange(slugify(sourceValue));
    }
  }, [sourceValue, manuallyEdited, onChange]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setManuallyEdited(true);
    onChange(slugify(e.target.value));
  };

  return (
    <Input
      value={value}
      onChange={handleChange}
      placeholder={placeholder}
      className={className}
    />
  );
}
