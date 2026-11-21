'use client';

import React from 'react';
import { useParams } from 'next/navigation';
import { AlertTriageWorkspace } from '@/components/triage/AlertTriageWorkspace';

export default function IncidentTriageAppPage() {
  const params = useParams();
  const id = typeof params?.id === 'string' ? params.id : 'INC-84920';

  return (
    <div className="space-y-6">
      <AlertTriageWorkspace incidentId={id} />
    </div>
  );
}
