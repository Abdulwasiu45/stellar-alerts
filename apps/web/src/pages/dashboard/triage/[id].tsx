import React from 'react';
import { useRouter } from 'next/router';
import Head from 'next/head';
import { AlertTriageWorkspace } from '@/components/triage/AlertTriageWorkspace';

export default function IncidentTriagePage() {
  const router = useRouter();
  const { id } = router.query;
  const incidentId = typeof id === 'string' ? id : Array.isArray(id) ? id[0] : 'INC-84920';

  return (
    <>
      <Head>
        <title>Incident Triage Workspace | StellarAlerts</title>
      </Head>
      <div className="min-h-screen bg-[#050508] text-gray-100 p-6 max-w-7xl mx-auto">
        <AlertTriageWorkspace incidentId={incidentId} />
      </div>
    </>
  );
}
