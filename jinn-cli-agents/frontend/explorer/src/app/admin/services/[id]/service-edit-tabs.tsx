'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ServiceForm } from '../../components/service-form';
import { DeploymentForm } from '../../components/deployment-form';
import { InterfaceForm } from '../../components/interface-form';
import { DocForm } from '../../components/doc-form';
import type { Service, Venture, Deployment, Interface, ServiceDoc } from '@/lib/ventures-services';
import { Plus, Pencil, Cloud, Plug, FileText } from 'lucide-react';

interface ServiceEditTabsProps {
  service: Service;
  ventures: Venture[];
  deployments: Deployment[];
  interfaces: Interface[];
  docs: ServiceDoc[];
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    active: 'bg-green-500/10 text-green-500 border-green-500/20',
    healthy: 'bg-green-500/10 text-green-500 border-green-500/20',
    published: 'bg-green-500/10 text-green-500 border-green-500/20',
    deprecated: 'bg-yellow-500/10 text-yellow-500 border-yellow-500/20',
    unhealthy: 'bg-red-500/10 text-red-500 border-red-500/20',
    failed: 'bg-red-500/10 text-red-500 border-red-500/20',
    stopped: 'bg-gray-500/10 text-gray-500 border-gray-500/20',
    archived: 'bg-gray-500/10 text-gray-500 border-gray-500/20',
    draft: 'bg-blue-500/10 text-blue-500 border-blue-500/20',
    deploying: 'bg-blue-500/10 text-blue-500 border-blue-500/20',
    removed: 'bg-gray-500/10 text-gray-500 border-gray-500/20',
    degraded: 'bg-yellow-500/10 text-yellow-500 border-yellow-500/20',
    unknown: 'bg-gray-500/10 text-gray-500 border-gray-500/20',
  };
  return (
    <Badge variant="outline" className={colors[status] || colors.unknown}>
      {status}
    </Badge>
  );
}

export function ServiceEditTabs({
  service,
  ventures,
  deployments,
  interfaces,
  docs,
}: ServiceEditTabsProps) {
  const router = useRouter();
  const [editingDeployment, setEditingDeployment] = React.useState<Deployment | null>(null);
  const [creatingDeployment, setCreatingDeployment] = React.useState(false);
  const [editingInterface, setEditingInterface] = React.useState<Interface | null>(null);
  const [creatingInterface, setCreatingInterface] = React.useState(false);
  const [editingDoc, setEditingDoc] = React.useState<ServiceDoc | null>(null);
  const [creatingDoc, setCreatingDoc] = React.useState(false);

  const handleDeploymentSuccess = () => {
    setEditingDeployment(null);
    setCreatingDeployment(false);
    router.refresh();
  };

  const handleInterfaceSuccess = () => {
    setEditingInterface(null);
    setCreatingInterface(false);
    router.refresh();
  };

  const handleDocSuccess = () => {
    setEditingDoc(null);
    setCreatingDoc(false);
    router.refresh();
  };

  return (
    <Tabs defaultValue="details" className="space-y-4">
      <TabsList className="w-full justify-start">
        <TabsTrigger value="details">Details</TabsTrigger>
        <TabsTrigger value="deployments" className="flex items-center gap-1">
          <Cloud className="h-4 w-4" />
          Deployments ({deployments.length})
        </TabsTrigger>
        <TabsTrigger value="interfaces" className="flex items-center gap-1">
          <Plug className="h-4 w-4" />
          Interfaces ({interfaces.length})
        </TabsTrigger>
        <TabsTrigger value="docs" className="flex items-center gap-1">
          <FileText className="h-4 w-4" />
          Docs ({docs.length})
        </TabsTrigger>
      </TabsList>

      <TabsContent value="details">
        <ServiceForm service={service} ventures={ventures} />
      </TabsContent>

      <TabsContent value="deployments" className="space-y-4">
        {(creatingDeployment || editingDeployment) && (
          <DeploymentForm
            deployment={editingDeployment || undefined}
            serviceId={service.id}
            onClose={() => {
              setCreatingDeployment(false);
              setEditingDeployment(null);
            }}
            onSuccess={handleDeploymentSuccess}
          />
        )}

        {!creatingDeployment && !editingDeployment && (
          <>
            <div className="flex justify-end">
              <Button onClick={() => setCreatingDeployment(true)}>
                <Plus className="h-4 w-4 mr-1" />
                Add Deployment
              </Button>
            </div>

            {deployments.length === 0 ? (
              <Card>
                <CardContent className="py-8 text-center">
                  <p className="text-muted-foreground">No deployments yet.</p>
                </CardContent>
              </Card>
            ) : (
              <div className="grid gap-4">
                {deployments.map((deployment) => (
                  <Card key={deployment.id}>
                    <CardHeader className="pb-2">
                      <div className="flex items-start justify-between">
                        <div className="space-y-1">
                          <CardTitle className="flex items-center gap-2 text-base">
                            {deployment.environment}
                            <Badge variant="outline">{deployment.provider}</Badge>
                          </CardTitle>
                          {deployment.url && (
                            <p className="text-sm text-muted-foreground font-mono">
                              {deployment.url}
                            </p>
                          )}
                        </div>
                        <div className="flex items-center gap-2">
                          <StatusBadge status={deployment.status} />
                          <StatusBadge status={deployment.health_status} />
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setEditingDeployment(deployment)}
                          >
                            <Pencil className="h-4 w-4 mr-1" />
                            Edit
                          </Button>
                        </div>
                      </div>
                    </CardHeader>
                    <CardContent>
                      <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                        {deployment.version && <span>v{deployment.version}</span>}
                        {deployment.provider_project_id && (
                          <span>Project: {deployment.provider_project_id}</span>
                        )}
                        <span>
                          Deployed: {new Date(deployment.deployed_at).toLocaleDateString()}
                        </span>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </>
        )}
      </TabsContent>

      <TabsContent value="interfaces" className="space-y-4">
        {(creatingInterface || editingInterface) && (
          <InterfaceForm
            interfaceData={editingInterface || undefined}
            serviceId={service.id}
            onClose={() => {
              setCreatingInterface(false);
              setEditingInterface(null);
            }}
            onSuccess={handleInterfaceSuccess}
          />
        )}

        {!creatingInterface && !editingInterface && (
          <>
            <div className="flex justify-end">
              <Button onClick={() => setCreatingInterface(true)}>
                <Plus className="h-4 w-4 mr-1" />
                Add Interface
              </Button>
            </div>

            {interfaces.length === 0 ? (
              <Card>
                <CardContent className="py-8 text-center">
                  <p className="text-muted-foreground">No interfaces yet.</p>
                </CardContent>
              </Card>
            ) : (
              <div className="grid gap-4">
                {interfaces.map((iface) => (
                  <Card key={iface.id}>
                    <CardHeader className="pb-2">
                      <div className="flex items-start justify-between">
                        <div className="space-y-1">
                          <CardTitle className="flex items-center gap-2 text-base">
                            {iface.name}
                            <Badge variant="outline">{iface.interface_type.replace('_', ' ')}</Badge>
                          </CardTitle>
                          {iface.description && (
                            <p className="text-sm text-muted-foreground">
                              {iface.description}
                            </p>
                          )}
                        </div>
                        <div className="flex items-center gap-2">
                          <StatusBadge status={iface.status} />
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setEditingInterface(iface)}
                          >
                            <Pencil className="h-4 w-4 mr-1" />
                            Edit
                          </Button>
                        </div>
                      </div>
                    </CardHeader>
                    <CardContent>
                      <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                        {iface.http_method && iface.http_path && (
                          <span className="font-mono">
                            {iface.http_method} {iface.http_path}
                          </span>
                        )}
                        {iface.auth_required && (
                          <span>Auth: {iface.auth_type || 'required'}</span>
                        )}
                        {iface.x402_price > 0 && (
                          <span>Price: ${(iface.x402_price / 100).toFixed(2)}</span>
                        )}
                        {iface.tags.length > 0 && (
                          <span>Tags: {iface.tags.join(', ')}</span>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </>
        )}
      </TabsContent>

      <TabsContent value="docs" className="space-y-4">
        {(creatingDoc || editingDoc) && (
          <DocForm
            doc={editingDoc || undefined}
            docs={docs}
            serviceId={service.id}
            onClose={() => {
              setCreatingDoc(false);
              setEditingDoc(null);
            }}
            onSuccess={handleDocSuccess}
          />
        )}

        {!creatingDoc && !editingDoc && (
          <>
            <div className="flex justify-end">
              <Button onClick={() => setCreatingDoc(true)}>
                <Plus className="h-4 w-4 mr-1" />
                Add Document
              </Button>
            </div>

            {docs.length === 0 ? (
              <Card>
                <CardContent className="py-8 text-center">
                  <p className="text-muted-foreground">No documents yet.</p>
                </CardContent>
              </Card>
            ) : (
              <div className="grid gap-4">
                {docs.map((doc) => (
                  <Card key={doc.id}>
                    <CardHeader className="pb-2">
                      <div className="flex items-start justify-between">
                        <div className="space-y-1">
                          <CardTitle className="flex items-center gap-2 text-base">
                            {doc.title}
                            <Badge variant="outline">{doc.doc_type}</Badge>
                          </CardTitle>
                          <p className="text-sm text-muted-foreground font-mono">
                            {doc.slug}
                          </p>
                        </div>
                        <div className="flex items-center gap-2">
                          <StatusBadge status={doc.status} />
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setEditingDoc(doc)}
                          >
                            <Pencil className="h-4 w-4 mr-1" />
                            Edit
                          </Button>
                        </div>
                      </div>
                    </CardHeader>
                    <CardContent>
                      <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                        {doc.author && <span>Author: {doc.author}</span>}
                        {doc.version && <span>v{doc.version}</span>}
                        {doc.tags.length > 0 && (
                          <span>Tags: {doc.tags.join(', ')}</span>
                        )}
                        <span>
                          Updated: {new Date(doc.updated_at).toLocaleDateString()}
                        </span>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </>
        )}
      </TabsContent>
    </Tabs>
  );
}
