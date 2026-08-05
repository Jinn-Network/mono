import defaultMdxComponents from 'fumadocs-ui/mdx';
import type { MDXComponents } from 'mdx/types';
import { PromptBlock } from '@/components/prompt-block';

export function getMDXComponents(components?: MDXComponents) {
  return {
    ...defaultMdxComponents,
    PromptBlock,
    ...components,
  } satisfies MDXComponents;
}

export const useMDXComponents = getMDXComponents;

declare global {
  type MDXProvidedComponents = ReturnType<typeof getMDXComponents>;
}
