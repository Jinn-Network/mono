import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { SectionCard } from '../../components/SectionCard.js';
import { api } from '../../api/client.js';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '../../components/ui/form.js';

/**
 * /operator/security — keystore password rotation (Funds-Password).
 *
 * Migrated to shadcn `Form` primitives (react-hook-form + zod) so
 * validation lives next to the schema and the inputs get a11y wiring
 * (aria-describedby, aria-invalid) for free.
 */
const passwordSchema = z
  .object({
    current: z.string().min(1, 'Current password is required.'),
    next: z.string().min(8, 'New password must be at least 8 characters.'),
  });

type PasswordFormValues = z.infer<typeof passwordSchema>;

export function SecurityTab(): JSX.Element {
  const [status, setStatus] = useState<'idle' | 'rotating' | 'rotated' | 'failed'>('idle');
  const [error, setError] = useState<string | null>(null);

  const form = useForm<PasswordFormValues>({
    resolver: zodResolver(passwordSchema),
    defaultValues: { current: '', next: '' },
  });

  const onSubmit = async (values: PasswordFormValues): Promise<void> => {
    setStatus('rotating');
    setError(null);
    try {
      await api.changeKeystorePassword(values.current, values.next);
      setStatus('rotated');
      form.reset({ current: '', next: '' });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus('failed');
    }
  };

  return (
    <div data-testid="security-tab">
      <SectionCard
        title="Security"
        summary="Rotate keystore password · last rotated never"
        metaChip={{ label: 'Danger zone', tone: 'danger' }}
        variant="danger"
        defaultExpanded={true}
      >
        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(onSubmit)}
            className="flex flex-col gap-4"
            data-testid="security-password-form"
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="current"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Current password</FormLabel>
                    <FormControl>
                      <Input type="password" autoComplete="current-password" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="next"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>New password</FormLabel>
                    <FormControl>
                      <Input type="password" autoComplete="new-password" {...field} />
                    </FormControl>
                    <FormDescription>At least 8 characters.</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <Button
              type="submit"
              variant="destructive"
              disabled={status === 'rotating' || !form.formState.isValid}
              className="self-start"
            >
              {status === 'rotating' ? 'Rotating…' : 'Rotate password'}
            </Button>
            {status === 'rotated' && (
              <span className="font-mono text-[12px] text-[var(--vow-green)]">
                Password rotated. Re-run jinn run with the new password.
              </span>
            )}
            {status === 'failed' && (
              <span className="font-mono text-[12px] text-[var(--break-red)]">
                Rotation failed: {error}
              </span>
            )}
          </form>
        </Form>
      </SectionCard>
    </div>
  );
}
