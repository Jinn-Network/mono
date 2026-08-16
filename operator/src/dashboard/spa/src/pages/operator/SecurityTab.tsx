import { useState, type JSX } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod/v3';
import { KeyRound, ShieldAlert } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../../api/client.js';
import { HarnessAuthStatusCard } from './HarnessAuthStatusCard.js';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card.js';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { Badge } from '../../components/ui/badge.js';
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
 * /operator/security — keystore password rotation.
 *
 * shadcn `Form` (react-hook-form + zod) so validation lives next to the
 * schema and inputs get a11y wiring (aria-describedby, aria-invalid) for
 * free. Success/failure surfaces via sonner toast — auto-dismiss replaces
 * the inline status string.
 */
const passwordSchema = z.object({
  current: z.string().min(1, 'Current password is required.'),
  next: z.string().min(8, 'New password must be at least 8 characters.'),
});

type PasswordFormValues = z.infer<typeof passwordSchema>;

export function SecurityTab(): JSX.Element {
  const [status, setStatus] = useState<'idle' | 'rotating'>('idle');

  const form = useForm<PasswordFormValues>({
    resolver: zodResolver(passwordSchema),
    defaultValues: { current: '', next: '' },
  });

  const onSubmit = async (values: PasswordFormValues): Promise<void> => {
    setStatus('rotating');
    try {
      await api.changeKeystorePassword(values.current, values.next);
      form.reset({ current: '', next: '' });
      toast.success('Password rotated', {
        description: 'Re-run `jinn run` with the new password.',
      });
    } catch (err) {
      toast.error('Rotation failed', {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setStatus('idle');
    }
  };

  return (
    <div data-testid="security-tab" className="flex flex-col gap-6">
      <Card className="border-[var(--severity-blocking-border)]">
        <CardHeader className="flex flex-row items-start justify-between gap-3">
          <div className="flex flex-col gap-1.5">
            <CardTitle className="flex items-center gap-2 text-[var(--break-red)]">
              <ShieldAlert className="h-3.5 w-3.5" aria-hidden="true" />
              Security
            </CardTitle>
            <CardDescription>Rotate keystore password · last rotated never</CardDescription>
          </div>
          <Badge variant="destructive">Danger zone</Badge>
        </CardHeader>
        <CardContent>
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
                <KeyRound className="h-3 w-3" aria-hidden="true" />
                {status === 'rotating' ? 'Rotating…' : 'Rotate password'}
              </Button>
            </form>
          </Form>
        </CardContent>
      </Card>
      <HarnessAuthStatusCard />
    </div>
  );
}
