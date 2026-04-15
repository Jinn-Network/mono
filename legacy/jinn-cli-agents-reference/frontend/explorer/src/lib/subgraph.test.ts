/**
 * GraphQL Schema Validation Tests
 * 
 * These tests ensure that our GraphQL queries only request fields that exist
 * in the Ponder schema, preventing runtime errors from schema mismatches.
 */

import { describe, it, expect } from 'vitest';
import { JOB_DEFINITIONS_QUERY, JOB_DEFINITION_QUERY } from './subgraph';

// Golden Schema: Valid fields for each entity type (from ponder/ponder.schema.ts)
const VALID_FIELDS = {
  jobDefinition: [
    'id',
    'name',
    'enabledTools',
    'blueprint',
    'sourceJobDefinitionId',
    'sourceRequestId',
    'codeMetadata',
  ],
  request: [
    'id',
    'mech',
    'sender',
    'workstreamId',
    'jobDefinitionId',
    'sourceRequestId',
    'sourceJobDefinitionId',
    'requestData',
    'ipfsHash',
    'deliveryIpfsHash',
    'transactionHash',
    'blockNumber',
    'blockTimestamp',
    'delivered',
    'jobName',
    'enabledTools',
    'additionalContext',
    'dependencies',
  ],
  delivery: [
    'id',
    'requestId',
    'sourceRequestId',
    'sourceJobDefinitionId',
    'mech',
    'mechServiceMultisig',
    'deliveryRate',
    'ipfsHash',
    'transactionHash',
    'blockNumber',
    'blockTimestamp',
  ],
  artifact: [
    'id',
    'requestId',
    'sourceRequestId',
    'sourceJobDefinitionId',
    'name',
    'cid',
    'topic',
    'contentPreview',
    'blockTimestamp',
    'type',
    'tags',
    'utilityScore',
    'accessCount',
  ],
  message: [
    'id',
    'requestId',
    'sourceRequestId',
    'sourceJobDefinitionId',
    'to',
    'content',
    'blockTimestamp',
  ],
  pageInfo: [
    'hasNextPage',
    'hasPreviousPage',
    'startCursor',
    'endCursor',
  ],
};

// Fields that should NOT exist (common mistakes)
const INVALID_FIELDS = {
  jobDefinition: ['promptContent', 'description', 'blockTimestamp', 'created_at'],
  request: ['description', 'created_at'],
  delivery: ['description', 'created_at'],
  artifact: ['description', 'created_at'],
  message: ['description', 'created_at'],
};

/**
 * Extract field names from a GraphQL query string
 */
function extractFields(query: string, typeName: string): string[] {
  // Find the type block (e.g., "jobDefinition {" or "jobDefinitions { items {")
  const typeRegex = new RegExp(`${typeName}[^{]*{([^}]*)}`, 'gs');
  const matches = query.matchAll(typeRegex);
  
  const fields: string[] = [];
  for (const match of matches) {
    const blockContent = match[1];
    // Extract field names (ignore nested objects like pageInfo)
    const fieldMatches = blockContent.matchAll(/^\s*(\w+)(?:\s|$)/gm);
    for (const fieldMatch of fieldMatches) {
      const fieldName = fieldMatch[1];
      // Skip GraphQL keywords and nested types
      if (fieldName !== 'items' && fieldName !== 'query' && fieldName !== 'mutation') {
        fields.push(fieldName);
      }
    }
  }
  
  return [...new Set(fields)]; // Remove duplicates
}

describe('GraphQL Schema Validation', () => {
  describe('JobDefinition Queries', () => {
    it('JOB_DEFINITIONS_QUERY should only request valid jobDefinition fields', () => {
      const requestedFields = extractFields(JOB_DEFINITIONS_QUERY, 'jobDefinition');
      
      requestedFields.forEach(field => {
        expect(
          VALID_FIELDS.jobDefinition,
          `Field "${field}" is not valid for jobDefinition. Valid fields: ${VALID_FIELDS.jobDefinition.join(', ')}`
        ).toContain(field);
      });
    });

    it('JOB_DEFINITIONS_QUERY should NOT request invalid fields', () => {
      const queryLower = JOB_DEFINITIONS_QUERY.toLowerCase();
      
      INVALID_FIELDS.jobDefinition.forEach(field => {
        expect(
          queryLower,
          `Query should NOT request invalid field "${field}"`
        ).not.toContain(field.toLowerCase());
      });
    });

    it('JOB_DEFINITION_QUERY should only request valid jobDefinition fields', () => {
      const requestedFields = extractFields(JOB_DEFINITION_QUERY, 'jobDefinition');
      
      requestedFields.forEach(field => {
        expect(
          VALID_FIELDS.jobDefinition,
          `Field "${field}" is not valid for jobDefinition`
        ).toContain(field);
      });
    });

    it('JOB_DEFINITION_QUERY should NOT request invalid fields', () => {
      const queryLower = JOB_DEFINITION_QUERY.toLowerCase();
      
      INVALID_FIELDS.jobDefinition.forEach(field => {
        expect(
          queryLower,
          `Query should NOT request invalid field "${field}"`
        ).not.toContain(field.toLowerCase());
      });
    });

    it('JOB_DEFINITIONS_QUERY should request pageInfo fields', () => {
      const requestedFields = extractFields(JOB_DEFINITIONS_QUERY, 'pageInfo');
      
      // Should have at least hasNextPage and hasPreviousPage
      expect(requestedFields).toContain('hasNextPage');
      expect(requestedFields).toContain('hasPreviousPage');
    });
  });

  describe('Regression Tests', () => {
    it('should NOT request promptContent field (regression test)', () => {
      expect(JOB_DEFINITIONS_QUERY).not.toContain('promptContent');
      expect(JOB_DEFINITION_QUERY).not.toContain('promptContent');
    });

    it('should NOT request description field on jobDefinition (regression test)', () => {
      expect(JOB_DEFINITIONS_QUERY).not.toContain('description');
      expect(JOB_DEFINITION_QUERY).not.toContain('description');
    });

    it('should request codeMetadata field (the actual field that exists)', () => {
      expect(JOB_DEFINITIONS_QUERY).toContain('codeMetadata');
      expect(JOB_DEFINITION_QUERY).toContain('codeMetadata');
    });

    it('should request blueprint field', () => {
      expect(JOB_DEFINITIONS_QUERY).toContain('blueprint');
      expect(JOB_DEFINITION_QUERY).toContain('blueprint');
    });
  });

  describe('Required Fields', () => {
    it('JOB_DEFINITIONS_QUERY should request all essential fields', () => {
      const essentialFields = ['id', 'name', 'enabledTools'];
      const requestedFields = extractFields(JOB_DEFINITIONS_QUERY, 'jobDefinition');
      
      essentialFields.forEach(field => {
        expect(
          requestedFields,
          `Essential field "${field}" must be requested`
        ).toContain(field);
      });
    });

    it('JOB_DEFINITION_QUERY should request all essential fields', () => {
      const essentialFields = ['id', 'name', 'enabledTools'];
      const requestedFields = extractFields(JOB_DEFINITION_QUERY, 'jobDefinition');
      
      essentialFields.forEach(field => {
        expect(
          requestedFields,
          `Essential field "${field}" must be requested`
        ).toContain(field);
      });
    });
  });
});

