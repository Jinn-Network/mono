'use client';

import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
import { createDeployment, updateDeployment, deleteDeployment, type DeploymentInput } from '../actions';
import type { Deployment } from '@/lib/ventures-services';
import { Loader2, Trash2, X } from 'lucide-react';

interface DeploymentFormProps {
  deployment?: Deployment;
  serviceId: string;
  onClose: () => void;
  onSuccess: () => void;
}

const ENVIRONMENTS = ['production', 'staging', 'development', 'preview'] as const;
const PROVIDERS = ['railway', 'vercel', 'cloudflare', 'aws', 'gcp', 'azure', 'self-hosted', 'other'] as const;
const STATUSES = ['active', 'stopped', 'failed', 'deploying'] as const;

export function DeploymentForm({ deployment, serviceId, onClose, onSuccess }: DeploymentFormProps) {
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = React.useState(false);

  const [environment, setEnvironment] = React.useState<DeploymentInput['environment']>(
    deployment?.environment || 'production'
  );
  const [provider, setProvider] = React.useState<DeploymentInput['provider']>(
    deployment?.provider || 'railway'
  );
  const [providerProjectId, setProviderProjectId] = React.useState(deployment?.provider_project_id || '');
  const [providerServiceId, setProviderServiceId] = React.useState(deployment?.provider_service_id || '');
  const [url, setUrl] = React.useState(deployment?.url || '');
  const [urls, setUrls] = React.useState((deployment?.urls || []).join('\n'));
  const [version, setVersion] = React.useState(deployment?.version || '');
  const [config, setConfig] = React.useState(
    JSON.stringify(deployment?.config || {}, null, 2)
  );
  const [healthCheckUrl, setHealthCheckUrl] = React.useState(deployment?.health_check_url || '');
  const [status, setStatus] = React.useState<DeploymentInput['status']>(
    deployment?.status || 'active'
  );

  const isEditing = !!deployment;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const urlsArray = urls.split('\n').map(u => u.trim()).filter(u => u.length > 0);

      const input: DeploymentInput = {
        service_id: serviceId,
        environment,
        provider,
        provider_project_id: providerProjectId || undefined,
        provider_service_id: providerServiceId || undefined,
        url: url || undefined,
        urls: urlsArray.length > 0 ? urlsArray : undefined,
        version: version || undefined,
        config: JSON.parse(config),
        health_check_url: healthCheckUrl || undefined,
        status,
      };

      const result = isEditing
        ? await updateDeployment(deployment.id, serviceId, input)
        : await createDeployment(input);

      if (result.error) {
        setError(result.error);
      } else {
        onSuccess();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!deployment) return;

    setLoading(true);
    setError(null);

    const result = await deleteDeployment(deployment.id, serviceId);

    if (result.error) {
      setError(result.error);
      setLoading(false);
    } else {
      onSuccess();
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>{isEditing ? 'Edit Deployment' : 'Add Deployment'}</CardTitle>
        <Button variant="ghost" size="icon" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </CardHeader>
      <form onSubmit={handleSubmit}>
        <CardContent className="space-y-4">
          {error && (
            <div className="p-3 text-sm text-destructive bg-destructive/10 rounded-md">
              {error}
            </div>
          )}

          <div className="grid gap-4 md:grid-cols-2">
            <FormField label="Environment" htmlFor="environment" required>
              <Select value={environment} onValueChange={(v) => setEnvironment(v as typeof environment)}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ENVIRONMENTS.map((env) => (
                    <SelectItem key={env} value={env}>
                      {env.charAt(0).toUpperCase() + env.slice(1)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>

            <FormField label="Provider" htmlFor="provider" required>
              <Select value={provider} onValueChange={(v) => setProvider(v as typeof provider)}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PROVIDERS.map((p) => (
                    <SelectItem key={p} value={p}>
                      {p.charAt(0).toUpperCase() + p.slice(1).replace('-', ' ')}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <FormField label="Provider Project ID" htmlFor="providerProjectId">
              <Input
                id="providerProjectId"
                value={providerProjectId}
                onChange={(e) => setProviderProjectId(e.target.value)}
                placeholder="project-abc123"
              />
            </FormField>

            <FormField label="Provider Service ID" htmlFor="providerServiceId">
              <Input
                id="providerServiceId"
                value={providerServiceId}
                onChange={(e) => setProviderServiceId(e.target.value)}
                placeholder="service-xyz789"
              />
            </FormField>
          </div>

          <FormField label="Primary URL" htmlFor="url">
            <Input
              id="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://my-service.example.com"
            />
          </FormField>

          <FormField label="Additional URLs" htmlFor="urls" description="One URL per line">
            <textarea
              id="urls"
              value={urls}
              onChange={(e) => setUrls(e.target.value)}
              placeholder="https://alias1.example.com&#10;https://alias2.example.com"
              rows={3}
              className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </FormField>

          <div className="grid gap-4 md:grid-cols-2">
            <FormField label="Version" htmlFor="version">
              <Input
                id="version"
                value={version}
                onChange={(e) => setVersion(e.target.value)}
                placeholder="1.0.0"
              />
            </FormField>

            <FormField label="Status" htmlFor="status">
              <Select value={status} onValueChange={(v) => setStatus(v as typeof status)}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STATUSES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {s.charAt(0).toUpperCase() + s.slice(1)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
          </div>

          <FormField label="Health Check URL" htmlFor="healthCheckUrl">
            <Input
              id="healthCheckUrl"
              value={healthCheckUrl}
              onChange={(e) => setHealthCheckUrl(e.target.value)}
              placeholder="https://my-service.example.com/health"
            />
          </FormField>

          <FormField label="Config" htmlFor="config" description="Additional configuration JSON">
            <JsonTextarea
              value={config}
              onChange={setConfig}
              rows={3}
            />
          </FormField>
        </CardContent>
        <CardFooter className="flex justify-between">
          <div>
            {isEditing && (
              deleteConfirm ? (
                <div className="flex items-center gap-2">
                  <span className="text-sm text-muted-foreground">Delete?</span>
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    onClick={handleDelete}
                    disabled={loading}
                  >
                    Yes
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setDeleteConfirm(false)}
                    disabled={loading}
                  >
                    No
                  </Button>
                </div>
              ) : (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
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
            <Button type="button" variant="outline" onClick={onClose} disabled={loading}>
              Cancel
            </Button>
            <Button type="submit" disabled={loading}>
              {loading && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
              {isEditing ? 'Save' : 'Add'}
            </Button>
          </div>
        </CardFooter>
      </form>
    </Card>
  );
}
