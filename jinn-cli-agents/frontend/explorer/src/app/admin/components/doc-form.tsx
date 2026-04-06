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
import { SlugInput } from './slug-input';
import { createServiceDoc, updateServiceDoc, deleteServiceDoc, type ServiceDocInput } from '../actions';
import type { ServiceDoc } from '@/lib/ventures-services';
import { Loader2, Trash2, X } from 'lucide-react';

interface DocFormProps {
  doc?: ServiceDoc;
  docs: ServiceDoc[];
  serviceId: string;
  onClose: () => void;
  onSuccess: () => void;
}

const DOC_TYPES = [
  { value: 'readme', label: 'README' },
  { value: 'guide', label: 'Guide' },
  { value: 'reference', label: 'Reference' },
  { value: 'tutorial', label: 'Tutorial' },
  { value: 'changelog', label: 'Changelog' },
  { value: 'api', label: 'API Docs' },
  { value: 'architecture', label: 'Architecture' },
  { value: 'runbook', label: 'Runbook' },
  { value: 'other', label: 'Other' },
] as const;

const CONTENT_FORMATS = ['markdown', 'html', 'plaintext'] as const;
const STATUSES = ['draft', 'published', 'archived'] as const;

export function DocForm({ doc, docs, serviceId, onClose, onSuccess }: DocFormProps) {
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = React.useState(false);

  const [title, setTitle] = React.useState(doc?.title || '');
  const [slug, setSlug] = React.useState(doc?.slug || '');
  const [docType, setDocType] = React.useState<ServiceDocInput['doc_type']>(
    doc?.doc_type || 'guide'
  );
  const [content, setContent] = React.useState(doc?.content || '');
  const [contentFormat, setContentFormat] = React.useState<ServiceDocInput['content_format']>(
    doc?.content_format || 'markdown'
  );
  const [parentId, setParentId] = React.useState(doc?.parent_id || '');
  const [sortOrder, setSortOrder] = React.useState(String(doc?.sort_order ?? 0));
  const [author, setAuthor] = React.useState(doc?.author || '');
  const [version, setVersion] = React.useState(doc?.version || '');
  const [externalUrl, setExternalUrl] = React.useState(doc?.external_url || '');
  const [config, setConfig] = React.useState(
    JSON.stringify(doc?.config || {}, null, 2)
  );
  const [tags, setTags] = React.useState<string[]>(doc?.tags || []);
  const [status, setStatus] = React.useState<ServiceDocInput['status']>(
    doc?.status || 'draft'
  );

  const isEditing = !!doc;

  const parentOptions = docs.filter(d => d.id !== doc?.id);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const input: ServiceDocInput = {
        service_id: serviceId,
        title,
        slug,
        doc_type: docType,
        content,
        content_format: contentFormat,
        parent_id: parentId || undefined,
        sort_order: parseInt(sortOrder) || 0,
        author: author || undefined,
        version: version || undefined,
        external_url: externalUrl || undefined,
        config: JSON.parse(config),
        tags,
        status,
      };

      const result = isEditing
        ? await updateServiceDoc(doc.id, serviceId, input)
        : await createServiceDoc(input);

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
    if (!doc) return;

    setLoading(true);
    setError(null);

    const result = await deleteServiceDoc(doc.id, serviceId);

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
        <CardTitle>{isEditing ? 'Edit Document' : 'Add Document'}</CardTitle>
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
            <FormField label="Title" htmlFor="title" required>
              <Input
                id="title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Getting Started Guide"
                required
              />
            </FormField>

            <FormField label="Slug" htmlFor="slug" description="URL-friendly identifier">
              <SlugInput
                value={slug}
                onChange={setSlug}
                sourceValue={title}
                placeholder="getting-started"
              />
            </FormField>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <FormField label="Document Type" htmlFor="docType" required>
              <Select value={docType} onValueChange={(v) => setDocType(v as ServiceDocInput['doc_type'])}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DOC_TYPES.map((type) => (
                    <SelectItem key={type.value} value={type.value}>
                      {type.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>

            <FormField label="Content Format" htmlFor="contentFormat">
              <Select value={contentFormat} onValueChange={(v) => setContentFormat(v as ServiceDocInput['content_format'])}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CONTENT_FORMATS.map((format) => (
                    <SelectItem key={format} value={format}>
                      {format.charAt(0).toUpperCase() + format.slice(1)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
          </div>

          <FormField label="Content" htmlFor="content" required description="Markdown content">
            <Textarea
              id="content"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="# Getting Started&#10;&#10;Write your documentation here..."
              rows={12}
              className="font-mono text-sm"
              required
            />
          </FormField>

          <div className="grid gap-4 md:grid-cols-2">
            <FormField label="Parent Document" htmlFor="parentId" description="For hierarchical organization">
              <Select value={parentId} onValueChange={setParentId}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="None (top-level)" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">None (top-level)</SelectItem>
                  {parentOptions.map((d) => (
                    <SelectItem key={d.id} value={d.id}>
                      {d.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>

            <FormField label="Sort Order" htmlFor="sortOrder">
              <Input
                id="sortOrder"
                type="number"
                value={sortOrder}
                onChange={(e) => setSortOrder(e.target.value)}
                placeholder="0"
              />
            </FormField>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <FormField label="Author" htmlFor="author">
              <Input
                id="author"
                value={author}
                onChange={(e) => setAuthor(e.target.value)}
                placeholder="John Doe"
              />
            </FormField>

            <FormField label="Version" htmlFor="version">
              <Input
                id="version"
                value={version}
                onChange={(e) => setVersion(e.target.value)}
                placeholder="1.0.0"
              />
            </FormField>
          </div>

          <FormField label="External URL" htmlFor="externalUrl" description="Link to external documentation">
            <Input
              id="externalUrl"
              value={externalUrl}
              onChange={(e) => setExternalUrl(e.target.value)}
              placeholder="https://docs.example.com/..."
            />
          </FormField>

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
