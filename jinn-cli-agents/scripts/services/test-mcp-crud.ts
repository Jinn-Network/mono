#!/usr/bin/env tsx
/**
 * Test MCP tool CRUD operations for services, deployments, interfaces, and docs
 */

import { serviceRegistry } from 'jinn-node/agent/mcp/tools/service_registry.js';

interface TestResult {
  test: string;
  ok: boolean;
  message?: string;
}

async function parseResult(result: any): Promise<{ data: any; meta: { ok: boolean; message?: string } }> {
  return JSON.parse(result.content[0].text);
}

async function main() {
  console.log('============================================================');
  console.log('MCP TOOL CRUD TESTS');
  console.log('============================================================\n');

  const results: TestResult[] = [];

  // Get a service to use for tests
  const listResult = await serviceRegistry({ action: 'list_services', limit: 1 });
  const services = await parseResult(listResult);

  if (!services.data?.services?.length) {
    console.log('ERROR: No services found to test with');
    process.exit(1);
  }

  const serviceId = services.data.services[0].id;
  const serviceName = services.data.services[0].name;
  console.log(`Using service: ${serviceName} (${serviceId})\n`);

  // ============================================================
  // SERVICE TESTS
  // ============================================================
  console.log('--- SERVICES ---');

  // Create
  const createSvc = await serviceRegistry({
    action: 'create_service',
    ventureId: services.data.services[0].venture_id,
    name: 'Test MCP CRUD Service',
    description: 'Test service for MCP CRUD verification'
  });
  const createSvcData = await parseResult(createSvc);
  const svcId = createSvcData.data?.service?.id;
  console.log('CREATE service:', createSvcData.meta.ok ? '✓ PASS' : '✗ FAIL', svcId || createSvcData.meta.message);
  results.push({ test: 'service_create', ok: createSvcData.meta.ok });

  // Get
  if (svcId) {
    const getSvc = await serviceRegistry({ action: 'get_service', id: svcId });
    const getSvcData = await parseResult(getSvc);
    console.log('GET service:', getSvcData.meta.ok ? '✓ PASS' : '✗ FAIL');
    results.push({ test: 'service_get', ok: getSvcData.meta.ok });
  }

  // List
  const listSvc = await serviceRegistry({ action: 'list_services', limit: 10 });
  const listSvcData = await parseResult(listSvc);
  console.log('LIST services:', listSvcData.meta.ok ? '✓ PASS' : '✗ FAIL', 'count:', listSvcData.data?.count);
  results.push({ test: 'service_list', ok: listSvcData.meta.ok });

  // Update
  if (svcId) {
    const updateSvc = await serviceRegistry({
      action: 'update_service',
      id: svcId,
      description: 'Updated description for test'
    });
    const updateSvcData = await parseResult(updateSvc);
    console.log('UPDATE service:', updateSvcData.meta.ok ? '✓ PASS' : '✗ FAIL');
    results.push({ test: 'service_update', ok: updateSvcData.meta.ok });

    // Delete
    const deleteSvc = await serviceRegistry({ action: 'delete_service', id: svcId });
    const deleteSvcData = await parseResult(deleteSvc);
    console.log('DELETE service:', deleteSvcData.meta.ok ? '✓ PASS' : '✗ FAIL');
    results.push({ test: 'service_delete', ok: deleteSvcData.meta.ok });
  }

  // ============================================================
  // DEPLOYMENT TESTS
  // ============================================================
  console.log('\n--- DEPLOYMENTS ---');

  // Create
  const createDep = await serviceRegistry({
    action: 'create_deployment',
    serviceId,
    environment: 'staging',
    provider: 'railway',
    url: 'https://test-mcp-crud.railway.app'
  });
  const createDepData = await parseResult(createDep);
  const depId = createDepData.data?.deployment?.id;
  console.log('CREATE deployment:', createDepData.meta.ok ? '✓ PASS' : '✗ FAIL', depId || createDepData.meta.message);
  results.push({ test: 'deployment_create', ok: createDepData.meta.ok });

  // List
  const listDep = await serviceRegistry({ action: 'list_deployments', serviceId });
  const listDepData = await parseResult(listDep);
  console.log('LIST deployments:', listDepData.meta.ok ? '✓ PASS' : '✗ FAIL', 'count:', listDepData.data?.count);
  results.push({ test: 'deployment_list', ok: listDepData.meta.ok });

  // Update
  if (depId) {
    const updateDep = await serviceRegistry({
      action: 'update_deployment',
      id: depId,
      healthStatus: 'healthy',
      version: '1.0.0-test'
    });
    const updateDepData = await parseResult(updateDep);
    console.log('UPDATE deployment:', updateDepData.meta.ok ? '✓ PASS' : '✗ FAIL');
    results.push({ test: 'deployment_update', ok: updateDepData.meta.ok });

    // Delete
    const deleteDep = await serviceRegistry({ action: 'delete_deployment', id: depId });
    const deleteDepData = await parseResult(deleteDep);
    console.log('DELETE deployment:', deleteDepData.meta.ok ? '✓ PASS' : '✗ FAIL');
    results.push({ test: 'deployment_delete', ok: deleteDepData.meta.ok });
  }

  // ============================================================
  // INTERFACE TESTS
  // ============================================================
  console.log('\n--- INTERFACES ---');

  // Create
  const createInt = await serviceRegistry({
    action: 'create_interface',
    serviceId,
    name: 'test_mcp_crud_interface_' + Date.now(),
    interfaceType: 'mcp_tool',
    description: 'Test interface for MCP CRUD verification'
  });
  const createIntData = await parseResult(createInt);
  const intId = createIntData.data?.interface?.id;
  console.log('CREATE interface:', createIntData.meta.ok ? '✓ PASS' : '✗ FAIL', intId || createIntData.meta.message);
  results.push({ test: 'interface_create', ok: createIntData.meta.ok });

  // List
  const listInt = await serviceRegistry({ action: 'list_interfaces', serviceId });
  const listIntData = await parseResult(listInt);
  console.log('LIST interfaces:', listIntData.meta.ok ? '✓ PASS' : '✗ FAIL', 'count:', listIntData.data?.count);
  results.push({ test: 'interface_list', ok: listIntData.meta.ok });

  // Update
  if (intId) {
    const updateInt = await serviceRegistry({
      action: 'update_interface',
      id: intId,
      description: 'Updated description',
      status: 'deprecated'
    });
    const updateIntData = await parseResult(updateInt);
    console.log('UPDATE interface:', updateIntData.meta.ok ? '✓ PASS' : '✗ FAIL');
    results.push({ test: 'interface_update', ok: updateIntData.meta.ok });

    // Delete
    const deleteInt = await serviceRegistry({ action: 'delete_interface', id: intId });
    const deleteIntData = await parseResult(deleteInt);
    console.log('DELETE interface:', deleteIntData.meta.ok ? '✓ PASS' : '✗ FAIL');
    results.push({ test: 'interface_delete', ok: deleteIntData.meta.ok });
  }

  // ============================================================
  // DOC TESTS
  // ============================================================
  console.log('\n--- DOCS ---');

  // Create
  const createDoc = await serviceRegistry({
    action: 'create_doc',
    serviceId,
    title: 'Test MCP CRUD Doc',
    docType: 'guide',
    content: '# Test Doc\n\nThis is a test document for MCP CRUD verification.'
  });
  const createDocData = await parseResult(createDoc);
  const docId = createDocData.data?.doc?.id;
  console.log('CREATE doc:', createDocData.meta.ok ? '✓ PASS' : '✗ FAIL', docId || createDocData.meta.message);
  results.push({ test: 'doc_create', ok: createDocData.meta.ok });

  // Get
  if (docId) {
    const getDoc = await serviceRegistry({ action: 'get_doc', id: docId });
    const getDocData = await parseResult(getDoc);
    console.log('GET doc:', getDocData.meta.ok ? '✓ PASS' : '✗ FAIL');
    results.push({ test: 'doc_get', ok: getDocData.meta.ok });
  }

  // List
  const listDoc = await serviceRegistry({ action: 'list_docs', serviceId });
  const listDocData = await parseResult(listDoc);
  console.log('LIST docs:', listDocData.meta.ok ? '✓ PASS' : '✗ FAIL', 'count:', listDocData.data?.count);
  results.push({ test: 'doc_list', ok: listDocData.meta.ok });

  // Update
  if (docId) {
    const updateDoc = await serviceRegistry({
      action: 'update_doc',
      id: docId,
      title: 'Test MCP CRUD Doc (Updated)',
      docStatus: 'published'
    });
    const updateDocData = await parseResult(updateDoc);
    console.log('UPDATE doc:', updateDocData.meta.ok ? '✓ PASS' : '✗ FAIL');
    results.push({ test: 'doc_update', ok: updateDocData.meta.ok });

    // Delete
    const deleteDoc = await serviceRegistry({ action: 'delete_doc', id: docId });
    const deleteDocData = await parseResult(deleteDoc);
    console.log('DELETE doc:', deleteDocData.meta.ok ? '✓ PASS' : '✗ FAIL');
    results.push({ test: 'doc_delete', ok: deleteDocData.meta.ok });
  }

  // ============================================================
  // SUMMARY
  // ============================================================
  console.log('\n============================================================');
  console.log('SUMMARY');
  console.log('============================================================');

  const passed = results.filter(r => r.ok).length;
  const total = results.length;

  console.log(`\nTotal: ${total} | Passed: ${passed} | Failed: ${total - passed}\n`);

  results.forEach(r => {
    console.log(`  ${r.ok ? '✓' : '✗'} ${r.test}`);
  });

  if (passed === total) {
    console.log('\n✅ All MCP tool tests passed!');
    process.exit(0);
  } else {
    console.log('\n❌ Some tests failed');
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
