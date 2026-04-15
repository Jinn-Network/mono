import { TimelineEvent } from '@/lib/types';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { IdLink } from './id-link';

// Helper to render specific details for each event type
const renderEventDetails = (event: TimelineEvent) => {
  switch (event.event_type) {
    case 'ARTIFACT_CREATED':
      return (
        <>
          {event.event_details.topic && <p>Topic: {event.event_details.topic}</p>}
          {event.event_details.status && <p>Status: {event.event_details.status}</p>}
          <IdLink collection="artifacts" id={event.event_details.id} />
        </>
      );
    case 'JOB_CREATED':
      return (
        <>
          {event.event_details.name && <p>Job Name: {event.event_details.name}</p>}
          {event.event_details.status && <p>Status: {event.event_details.status}</p>}
          <IdLink collection="job_board" id={event.event_details.id} />
<a href={`/jobs/${event.event_details.id}/impact`} className="text-xs text-blue-500 hover:underline ml-2">
  View Impact
</a>
        </>
      );
    case 'THREAD_CREATED':
      return (
        <>
          {event.event_details.objective && <p>Objective: {event.event_details.objective}</p>}
          <IdLink collection="threads" id={event.event_details.id} />
        </>
      );
    default:
      return <p>{JSON.stringify(event.event_details)}</p>;
  }
};

export default function EventTimeline({ events }: { events: TimelineEvent[] }) {
  if (!events || events.length === 0) {
    return (
      <div className="text-center py-8 text-gray-500">
        No events found for this thread.
      </div>
    );
  }

  return (
    <div className="relative border-l-2 border-gray-200">
      {events.map((event, index) => (
        <div key={index} className="mb-8 ml-4">
          <div className="absolute w-3 h-3 bg-gray-300 rounded-full -left-1.5 mt-1.5"></div>
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">{event.event_type.replace('_', ' ')}</CardTitle>
              <time className="text-sm text-gray-500">
                {new Date(event.created_at).toLocaleString()}
              </time>
            </CardHeader>
            <CardContent>
              {renderEventDetails(event)}
            </CardContent>
          </Card>
        </div>
      ))}
    </div>
  );
}