'use client';

import * as React from 'react';
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
import { TagInput } from './tag-input';
import { Checkbox } from './checkbox';
import { createInterface, updateInterface, deleteInterface, type InterfaceInput } from '../actions';
import type { Interface } from '@/lib/ventures-services';
import { Loader2, Trash2, X } from 'lucide-react';

interface InterfaceFormProps {
  interfaceData?: Interface;
  serviceId: string;
  onClose: () => void;
  onSuccess: () => void;
}

const INTERFACE_TYPES = [
  { value: 'mcp_tool', label: 'MCP Tool' },
  { value: 'rest_endpoint', label: 'REST Endpoint' },
  { value: 'graphql', label: 'GraphQL' },
  { value: 'grpc', label: 'gRPC' },
  { value: 'websocket', label: 'WebSocket' },
  { value: 'webhook', label: 'Webhook' },
  { value: 'other', label: 'Other' },
] as const;

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'] as const;
const AUTH_TYPES = ['bearer', 'api_key', 'oauth', 'x402', 'none'] as const;
const STATUSES = ['active', 'deprecated', 'removed'] as const;

export function InterfaceForm({ interfaceData, serviceId, onClose, onSuccess }: InterfaceFormProps) {
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = React.useState(false);

  const [name, setName] = React.useState(interfaceData?.name || '');
  const [interfaceType, setInterfaceType] = React.useState<InterfaceInput['interface_type']>(
    interfaceData?.interface_type || 'rest_endpoint'
  );
  const [description, setDescription] = React.useState(interfaceData?.description || '');
  const [mcpSchema, setMcpSchema] = React.useState(
    JSON.stringify(interfaceData?.mcp_schema || {}, null, 2)
  );
  const [httpMethod, setHttpMethod] = React.useState<InterfaceInput['http_method'] | ''>(
    interfaceData?.http_method || ''
  );
  const [httpPath, setHttpPath] = React.useState(interfaceData?.http_path || '');
  const [inputSchema, setInputSchema] = React.useState(
    JSON.stringify(interfaceData?.input_schema || {}, null, 2)
  );
  const [outputSchema, setOutputSchema] = React.useState(
    JSON.stringify(interfaceData?.output_schema || {}, null, 2)
  );
  const [authRequired, setAuthRequired] = React.useState(interfaceData?.auth_required ?? false);
  const [authType, setAuthType] = React.useState<InterfaceInput['auth_type'] | ''>(
    interfaceData?.auth_type || ''
  );
  const [rateLimit, setRateLimit] = React.useState(
    JSON.stringify(interfaceData?.rate_limit || {}, null, 2)
  );
  const [x402Price, setX402Price] = React.useState(String(interfaceData?.x402_price ?? 0));
  const [config, setConfig] = React.useState(
    JSON.stringify(interfaceData?.config || {}, null, 2)
  );
  const [tags, setTags] = React.useState<string[]>(interfaceData?.tags || []);
  const [status, setStatus] = React.useState<InterfaceInput['status']>(
    interfaceData?.status || 'active'
  );

  const isEditing = !!interfaceData;
  const showMcpFields = interfaceType === 'mcp_tool';
  const showHttpFields = interfaceType === 'rest_endpoint' || interfaceType === 'webhook';

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const parsedMcpSchema = mcpSchema.trim() && mcpSchema !== '{}' ? JSON.parse(mcpSchema) : undefined;
      const parsedInputSchema = inputSchema.trim() && inputSchema !== '{}' ? JSON.parse(inputSchema) : undefined;
      const parsedOutputSchema = outputSchema.trim() && outputSchema !== '{}' ? JSON.parse(outputSchema) : undefined;
      const parsedRateLimit = rateLimit.trim() && rateLimit !== '{}' ? JSON.parse(rateLimit) : undefined;

      const input: InterfaceInput = {
        service_id: serviceId,
        name,
        interface_type: interfaceType,
        description: description || undefined,
        mcp_schema: parsedMcpSchema,
        http_method: httpMethod || undefined,
        http_path: httpPath || undefined,
        input_schema: parsedInputSchema,
        output_schema: parsedOutputSchema,
        auth_required: authRequired,
        auth_type: authType || undefined,
        rate_limit: parsedRateLimit,
        x402_price: parseFloat(x402Price) || 0,
        config: JSON.parse(config),
        tags,
        status,
      };

      const result = isEditing
        ? await updateInterface(interfaceData.id, serviceId, input)
        : await createInterface(input);

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
    if (!interfaceData) return;

    setLoading(true);
    setError(null);

    const result = await deleteInterface(interfaceData.id, serviceId);

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
        <CardTitle>{isEditing ? 'Edit Interface' : 'Add Interface'}</CardTitle>
        <Button variant="ghost" size="icon" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </CardHeader>
      <form onSubmit={handleSubmit}>
        <CardContent className="space-y-4 max-h-[60vh] overflow-y-auto">
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
                placeholder="get_user"
                required
              />
            </FormField>

            <FormField label="Type" htmlFor="interfaceType" required>
              <Select
                value={interfaceType}
                onValueChange={(v) => setInterfaceType(v as InterfaceInput['interface_type'])}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {INTERFACE_TYPES.map((type) => (
                    <SelectItem key={type.value} value={type.value}>
                      {type.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
          </div>

          <FormField label="Description" htmlFor="description">
            <Textarea
              id="description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Brief description of what this interface does..."
              rows={2}
            />
          </FormField>

          {showMcpFields && (
            <FormField label="MCP Schema" htmlFor="mcpSchema" description="JSON Schema for the MCP tool">
              <JsonTextarea
                value={mcpSchema}
                onChange={setMcpSchema}
                rows={6}
              />
            </FormField>
          )}

          {showHttpFields && (
            <div className="grid gap-4 md:grid-cols-2">
              <FormField label="HTTP Method" htmlFor="httpMethod">
                <Select value={httpMethod} onValueChange={(v) => setHttpMethod(v as InterfaceInput['http_method'])}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Select method" />
                  </SelectTrigger>
                  <SelectContent>
                    {HTTP_METHODS.map((method) => (
                      <SelectItem key={method} value={method}>
                        {method}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormField>

              <FormField label="HTTP Path" htmlFor="httpPath">
                <Input
                  id="httpPath"
                  value={httpPath}
                  onChange={(e) => setHttpPath(e.target.value)}
                  placeholder="/api/v1/users/{id}"
                />
              </FormField>
            </div>
          )}

          <div className="grid gap-4 md:grid-cols-2">
            <FormField label="Input Schema" htmlFor="inputSchema" description="JSON Schema">
              <JsonTextarea
                value={inputSchema}
                onChange={setInputSchema}
                rows={4}
              />
            </FormField>

            <FormField label="Output Schema" htmlFor="outputSchema" description="JSON Schema">
              <JsonTextarea
                value={outputSchema}
                onChange={setOutputSchema}
                rows={4}
              />
            </FormField>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <FormField label="Auth Required" htmlFor="authRequired">
              <div className="flex items-center gap-2 pt-2">
                <Checkbox
                  id="authRequired"
                  checked={authRequired}
                  onCheckedChange={setAuthRequired}
                />
                <label htmlFor="authRequired" className="text-sm">
                  Requires authentication
                </label>
              </div>
            </FormField>

            {authRequired && (
              <FormField label="Auth Type" htmlFor="authType">
                <Select value={authType} onValueChange={(v) => setAuthType(v as InterfaceInput['auth_type'])}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Select auth type" />
                  </SelectTrigger>
                  <SelectContent>
                    {AUTH_TYPES.map((type) => (
                      <SelectItem key={type} value={type}>
                        {type === 'x402' ? 'x402 Payment' : type.charAt(0).toUpperCase() + type.slice(1).replace('_', ' ')}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormField>
            )}
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <FormField label="Rate Limit" htmlFor="rateLimit" description="JSON config">
              <JsonTextarea
                value={rateLimit}
                onChange={setRateLimit}
                rows={3}
              />
            </FormField>

            <FormField label="x402 Price" htmlFor="x402Price" description="Price in cents">
              <Input
                id="x402Price"
                type="number"
                value={x402Price}
                onChange={(e) => setX402Price(e.target.value)}
                placeholder="0"
                min="0"
                step="0.01"
              />
            </FormField>
          </div>

          <FormField label="Config" htmlFor="config" description="Additional configuration">
            <JsonTextarea
              value={config}
              onChange={setConfig}
              rows={3}
            />
          </FormField>

          <div className="grid gap-4 md:grid-cols-2">
            <FormField label="Tags" htmlFor="tags" description="Comma-separated">
              <TagInput value={tags} onChange={setTags} />
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
