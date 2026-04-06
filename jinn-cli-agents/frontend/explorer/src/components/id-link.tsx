import React from 'react'
import { TruncatedId } from './truncated-id'

interface IdLinkPropsWithField {
  id: string | null | undefined
  fieldName: string
  className?: string
  showFullId?: boolean
}

interface IdLinkPropsWithCollection {
  id: string | null | undefined
  collection: string
  className?: string
  showFullId?: boolean
}

type IdLinkProps = IdLinkPropsWithField | IdLinkPropsWithCollection;

// Mapping of field names to their corresponding collection names
const fieldToCollectionMap: Record<string, string> = {
  'job_report_id': 'job_reports', 
  'job_id': 'job_board',
  'source_event_id': 'events',
};

/**
 * @deprecated Use TruncatedId component directly instead
 * This component is maintained for backward compatibility
 */
export function IdLink(props: IdLinkProps) {
  const { id, className = '', showFullId = false } = props;
  
  // If no ID, return null
  if (!id) {
    return <span className="text-gray-400 italic">null</span>
  }

  // Get the target collection from either the field name or collection prop
  let targetCollection: string | undefined;
  
  if ('collection' in props) {
    targetCollection = props.collection;
  } else if ('fieldName' in props) {
    targetCollection = fieldToCollectionMap[props.fieldName];
  }
  
  // If we don't know where this field should link, just display the ID
  if (!targetCollection) {
    return (
      <TruncatedId 
        value={id}
        showFull={showFullId}
        className={className}
        copyable={true}
      />
    )
  }

  // Create the link using TruncatedId
  return (
    <TruncatedId 
      value={id}
      linkTo={`/${targetCollection}/${id}`}
      showFull={showFullId}
      className={className}
      copyable={true}
    />
  )
}