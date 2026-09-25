import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Paperclip } from 'lucide-react';
import { Panel, Button } from '@/components/ui/primitives';
import { useToast } from '@/components/ui/toast';
import { useIdentity } from '@/lib/queries';
import * as api from '@/lib/api';

export function Attachments({ table, id, canEdit }: { table: api.Store; id: string; canEdit: boolean }) {
  const toast = useToast();
  const { data: identity } = useIdentity();
  const enabled = Boolean(identity?.instance.attachmentsEnabled);
  const fileInput = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const { data: files, refetch } = useQuery({
    queryKey: ['attachments', table, id],
    queryFn: () => api.attachments(table, id),
    enabled: Boolean(id) && enabled,
  });

  const upload = async (file: File) => {
    setUploading(true);
    try { await api.uploadAttachment(table, id, file); toast.success(`Attached ${file.name}.`); refetch(); }
    catch (e) { toast.error(api.errorText(e)); }
    finally { setUploading(false); if (fileInput.current) fileInput.current.value = ''; }
  };

  const maxMb = Math.round((files?.maxBytes || 0) / 1_048_576) || 8;

  return (
    <Panel
      title="Files"
      subtitle={enabled ? 'Kept on this server, never sent anywhere else' : 'disabled on this deployment'}
      action={canEdit && enabled
        ? <Button size="sm" loading={uploading} onClick={() => fileInput.current?.click()}><Paperclip className="h-3.5 w-3.5" />Add</Button>
        : undefined}
    >
      <input ref={fileInput} type="file" className="sr-only" aria-hidden="true" tabIndex={-1}
        onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); }} />
      {!enabled ? <p className="text-sm text-ink-3">Use evidence links instead.</p>
        : !files?.attachments?.length ? (
          <p className="text-sm text-ink-3">No files yet. Attach the sheet, the signed copy, or the screenshot. Up to {maxMb} MB each.</p>
        ) : (
          <ul className="space-y-1.5">
            {files.attachments.map((f: { id: string; original_name: string; size_bytes: number }) => (
              <li key={f.id} className="flex items-center gap-2 text-sm">
                <a href={api.attachmentUrl(table, id, f.id)} className="link min-w-0 flex-1 truncate">{f.original_name}</a>
                <span className="fig text-2xs text-ink-3">{Math.max(1, Math.round(f.size_bytes / 1024))} KB</span>
                {canEdit && (
                  <button type="button" className="text-ink-3 hover:text-bad" aria-label={`Remove ${f.original_name}`}
                    onClick={async () => {
                      try { await api.deleteAttachment(table, id, f.id); refetch(); }
                      catch (e) { toast.error(api.errorText(e)); }
                    }}>×</button>
                )}
              </li>
            ))}
          </ul>
        )}
    </Panel>
  );
}
