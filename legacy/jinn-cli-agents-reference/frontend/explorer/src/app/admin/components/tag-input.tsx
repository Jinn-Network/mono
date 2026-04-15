'use client';

import * as React from 'react';
import { Input } from '@/components/ui/input';

interface TagInputProps {
  value: string[];
  onChange: (value: string[]) => void;
  placeholder?: string;
  className?: string;
}

export function TagInput({
  value,
  onChange,
  placeholder = 'tag1, tag2, tag3',
  className,
}: TagInputProps) {
  const [inputValue, setInputValue] = React.useState(value.join(', '));

  React.useEffect(() => {
    setInputValue(value.join(', '));
  }, [value]);

  const handleBlur = () => {
    const tags = inputValue
      .split(',')
      .map(tag => tag.trim())
      .filter(tag => tag.length > 0);
    onChange(tags);
    setInputValue(tags.join(', '));
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setInputValue(e.target.value);
  };

  return (
    <Input
      value={inputValue}
      onChange={handleChange}
      onBlur={handleBlur}
      placeholder={placeholder}
      className={className}
    />
  );
}
