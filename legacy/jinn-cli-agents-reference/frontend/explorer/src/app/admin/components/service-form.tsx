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
import { SlugInput } from './slug-input';
import { createService, updateService, deleteService, type ServiceInput } from '../actions';
import type { Service, Venture } from '@/lib/ventures-services';
import { Loader2, Trash2 } from 'lucide-react';

interface ServiceFormProps {
  service?: Service;
  ventures: Venture[];
}

export function ServiceForm({ service, ventures }: ServiceFormProps) {
  const router = useRouter();
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = React.useState(false);

  const [ventureId, setVentureId] = React.useState(service?.venture_id || '');
  const [name, setName] = React.useState(service?.name || '');
  const [slug, setSlug] = React.useState(service?.slug || '');
  const [description, setDescription] = React.useState(service?.description || '');
  const [repositoryUrl, setRepositoryUrl] = React.useState(service?.repository_url || '');

  const isEditing = !!service;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const input: ServiceInput = {
        venture_id: ventureId,
        name,
        slug,
        description: description || undefined,
        repository_url: repositoryUrl || undefined,
      };

      const result = isEditing
        ? await updateService(service.id, input)
        : await createService(input);

      if (result.error) {
        setError(result.error);
      } else {
        router.push('/admin/services');
        router.refresh();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!service) return;

    setLoading(true);
    setError(null);

    const result = await deleteService(service.id);

    if (result.error) {
      setError(result.error);
      setLoading(false);
    } else {
      router.push('/admin/services');
      router.refresh();
    }
  };

  return (
    <form onSubmit={handleSubmit}>
      <Card>
        <CardHeader>
          <CardTitle>{isEditing ? 'Edit Service' : 'Create Service'}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {error && (
            <div className="p-3 text-sm text-destructive bg-destructive/10 rounded-md">
              {error}
            </div>
          )}

          <FormField label="Venture" htmlFor="ventureId" required>
            <Select value={ventureId} onValueChange={setVentureId} required>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Select a venture" />
              </SelectTrigger>
              <SelectContent>
                {ventures.map((v) => (
                  <SelectItem key={v.id} value={v.id}>
                    {v.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>

          <div className="grid gap-4 md:grid-cols-2">
            <FormField label="Name" htmlFor="name" required>
              <Input
                id="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="My Service"
                required
              />
            </FormField>

            <FormField label="Slug" htmlFor="slug" description="URL-friendly identifier">
              <SlugInput
                value={slug}
                onChange={setSlug}
                sourceValue={name}
                placeholder="my-service"
              />
            </FormField>
          </div>

          <FormField label="Description" htmlFor="description">
            <Textarea
              id="description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="A brief description of the service..."
              rows={3}
            />
          </FormField>

          <FormField label="Repository URL" htmlFor="repositoryUrl">
            <Input
              id="repositoryUrl"
              value={repositoryUrl}
              onChange={(e) => setRepositoryUrl(e.target.value)}
              placeholder="https://github.com/..."
            />
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
              {isEditing ? 'Save Changes' : 'Create Service'}
            </Button>
          </div>
        </CardFooter>
      </Card>
    </form>
  );
}
