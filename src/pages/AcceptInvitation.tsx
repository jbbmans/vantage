import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { UserCheck } from 'lucide-react';
import { Button, EmptyState, PageHeader, Skeleton } from '@/components/ui/primitives';
import { useToast } from '@/components/ui/toast';
import { withSudo } from '@/components/SudoDialog';
import { useIdentity } from '@/lib/queries';
import * as api from '@/lib/api';

/**
 * An invitation opened while signed in, or accepted right after signing in to an existing account: the person joins the
 * unit with the account they already have, so their record and history stay in one place (ADR-0009). Someone who has
 * transferred keeps everything they did at their last command; their new command sees what they share from here on.
 */
export default function AcceptInvitation() {
  const token = useMemo(() => new URLSearchParams(window.location.search).get('token') || '', []);
  const { data: identity } = useIdentity();
  const { data: invite, isLoading } = useQuery({ queryKey: ['invite', token], queryFn: () => api.inviteStatus(token) as Promise<{ valid: boolean; email: string | null; unit: string | null; invitedBy: string | null }>, enabled: Boolean(token), retry: false });
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const qc = useQueryClient();
  const navigate = useNavigate();
  useEffect(() => { document.title = 'Invitation | Vantage'; }, []);

  const accept = async () => {
    setBusy(true);
    try {
      const joined = await withSudo(() => api.claimInvite(token));
      await qc.invalidateQueries();
      toast.success(joined.primary ? `You joined ${joined.unit_name}. It is your primary unit.` : `You joined ${joined.unit_name}.`);
      navigate('/team', { replace: true });
    } catch (e) { toast.error(api.errorText(e)); } finally { setBusy(false); }
  };

  if (!token) return <div className="card"><EmptyState title="No invitation here" description="Open the link from your invitation email again." /></div>;
  if (isLoading || !identity) return <div className="card space-y-3"><Skeleton className="h-6 w-1/2" /><Skeleton className="h-4 w-3/4" /></div>;
  if (!invite?.valid) return <div className="card"><EmptyState title="This invitation cannot be used" description="It is invalid, has expired, or was already accepted. Ask your leader for a new one." /></div>;

  const self = identity.user;
  const otherAddress = Boolean(invite.email && (self.email || '').toLowerCase() !== invite.email.toLowerCase());
  return (
    <div className="mx-auto max-w-xl space-y-4">
      <PageHeader eyebrow="Your invitation" title={`Join ${invite.unit || 'the unit'}`} lede={`${invite.invitedBy || 'A leader'} invited you.`} />
      <div className="card space-y-3 p-5">
        <p className="text-sm text-ink">You join with the account you are signed in to, <span className="font-medium">{self.username}</span>. Your record and history stay with you; the unit’s leaders see what you share with it from here on.</p>
        {otherAddress && <p className="text-sm text-warn" role="note">This invitation was sent to another address. Sign in with the account that uses it, or ask your leader to invite this one.</p>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => navigate('/', { replace: true })}>Not now</Button>
          <Button variant="primary" loading={busy} disabled={otherAddress} onClick={accept}><UserCheck className="h-4 w-4" /> Join {invite.unit || 'the unit'}</Button>
        </div>
      </div>
    </div>
  );
}
