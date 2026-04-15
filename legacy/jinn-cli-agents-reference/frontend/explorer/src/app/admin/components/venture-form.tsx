'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { FormField } from './form-field';
import { JsonTextarea } from './json-textarea';
import { SlugInput } from './slug-input';
import { createVenture, updateVenture, deleteVenture, type VentureInput } from '../actions';
import type { Venture } from '@/lib/ventures-services';
import { Loader2, Trash2 } from 'lucide-react';

interface VentureFormProps {
  venture?: Venture;
}

const DEFAULT_BLUEPRINT = {
  invariants: [],
};

export function VentureForm({ venture }: VentureFormProps) {
  const router = useRouter();
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = React.useState(false);

  const [name, setName] = React.useState(venture?.name || '');
  const [slug, setSlug] = React.useState(venture?.slug || '');
  const [description, setDescription] = React.useState(venture?.description || '');
  const [ownerAddress, setOwnerAddress] = React.useState(venture?.owner_address || '');
  const [blueprint, setBlueprint] = React.useState(
    JSON.stringify(venture?.blueprint || DEFAULT_BLUEPRINT, null, 2)
  );
  const [rootWorkstreamId, setRootWorkstreamId] = React.useState(venture?.root_workstream_id || '');
  const [rootJobInstanceId, setRootJobInstanceId] = React.useState(venture?.root_job_instance_id || '');
  const [status, setStatus] = React.useState<'active' | 'paused' | 'archived'>(
    venture?.status || 'active'
  );

  const isEditing = !!venture;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const input: VentureInput = {
        name,
        slug,
        description: description || undefined,
        owner_address: ownerAddress,
        blueprint: JSON.parse(blueprint),
        root_workstream_id: rootWorkstreamId || undefined,
        root_job_instance_id: rootJobInstanceId || undefined,
        status,
      };

      const result = isEditing
        ? await updateVenture(venture.id, input)
        : await createVenture(input);

      if (result.error) {
        setError(result.error);
      } else {
        router.push('/admin/ventures');
        router.refresh();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!venture) return;

    setLoading(true);
    setError(null);

    const result = await deleteVenture(venture.id);

    if (result.error) {
      setError(result.error);
      setLoading(false);
    } else {
      router.push('/admin/ventures');
      router.refresh();
    }
  };

  return (
    <form onSubmit={handleSubmit}>
      <Card>
        <CardHeader>
          <CardTitle>{isEditing ? 'Edit Venture' : 'Create Venture'}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {error && (
            <div className="p-3 text-sm text-destructive bg-destructive/10 rounded-md">
              {error}
            </div>
          )}

          <div className="grid gap-4 md:grid-cols-2">
            <FormField label="Name" htmlFor="name" required>
              <Input
                id="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="My Venture"
                required
              />
            </FormField>

            <FormField label="Slug" htmlFor="slug" description="URL-friendly identifier">
              <SlugInput
                value={slug}
                onChange={setSlug}
                sourceValue={name}
                placeholder="my-venture"
              />
            </FormField>
          </div>

          <FormField label="Description" htmlFor="description">
            <Textarea
              id="description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="A brief description of the venture..."
              rows={3}
            />
          </FormField>

          <FormField label="Owner Address" htmlFor="ownerAddress" required>
            <Input
              id="ownerAddress"
              value={ownerAddress}
              onChange={(e) => setOwnerAddress(e.target.value)}
              placeholder="0x..."
              required
            />
          </FormField>

          <FormField
            label="Blueprint"
            htmlFor="blueprint"
            required
            description="JSON object with invariants array"
          >
            <JsonTextarea
              value={blueprint}
              onChange={setBlueprint}
              rows={6}
            />
          </FormField>

          <div className="grid gap-4 md:grid-cols-2">
            <FormField label="Root Workstream ID" htmlFor="rootWorkstreamId">
              <Input
                id="rootWorkstreamId"
                value={rootWorkstreamId}
                onChange={(e) => setRootWorkstreamId(e.target.value)}
                placeholder="Optional workstream ID"
              />
            </FormField>

            <FormField label="Root Job Instance ID" htmlFor="rootJobInstanceId">
              <Input
                id="rootJobInstanceId"
                value={rootJobInstanceId}
                onChange={(e) => setRootJobInstanceId(e.target.value)}
                placeholder="Optional job instance ID"
              />
            </FormField>
          </div>

          <FormField label="Status" htmlFor="status">
            <Select value={status} onValueChange={(v) => setStatus(v as typeof status)}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="active">Active</SelectItem>
                <SelectItem value="paused">Paused</SelectItem>
                <SelectItem value="archived">Archived</SelectItem>
              </SelectContent>
            </Select>
          </FormField>
        </CardContent>
        <CardFooter className="flex justify-between">
          <div>
            {isEditing && (
              deleteConfirm ? (
                <div className="flex items-center gap-2">
                  <span className="text-sm text-muted-foreground">Are you sure?</span>
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    onClick={handleDelete}
                    disabled={loading}
                  >
                    Yes, Delete
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setDeleteConfirm(false)}
                    disabled={loading}
                  >
                    Cancel
                  </Button>
                </div>
              ) : (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setDeleteConfirm(true)}
                  disabled={loading}
                >
                  <Trash2 className="h-4 w-4 mr-1" />
                  Delete
                </Button>
              )
            )}
          </div>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => router.back()}
              disabled={loading}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={loading}>
              {loading && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
              {isEditing ? 'Save Changes' : 'Create Venture'}
            </Button>
          </div>
        </CardFooter>
      </Card>
    </form>
  );
}
