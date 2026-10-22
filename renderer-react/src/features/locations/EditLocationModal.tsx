import { zodResolver } from '@hookform/resolvers/zod';
import { CONTENT_FORMATS, type ContentFormat, type ScanLocation } from '@omnidex/types/db';
import { Folder } from 'lucide-react';
import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { toast } from '@/components/ui/toaster';
import { trpc } from '@/ipc/trpc';

/**
 * `'asset'` is a UI-only stand-in for the DB's `content_format = NULL`. A Radix
 * Select cannot hold an empty-string value, so the null case needs a real token
 * in the form; it is mapped back to null on submit.
 */
const ASSET_OPTION = 'asset';

const CONTENT_FORMAT_LABELS: Record<ContentFormat, string> = {
  course: 'Courses',
  workshop: 'Workshops',
  ebook: 'E-books',
  reference: 'Reference',
  bookmark: 'Bookmarks',
};

const schema = z.object({
  name: z.string().min(1, 'Required'),
  path: z.string().min(1, 'Required'),
  is_active: z.boolean(),
  scan_recursive: z.boolean(),
  description: z.string(),
  content_format: z.enum([ASSET_OPTION, ...CONTENT_FORMATS]),
});

type FormValues = z.infer<typeof schema>;

interface EditLocationModalProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /**
   * When supplied the modal runs in edit mode: the form is prefilled and submit
   * patches via `scanLocations.update`. Omit it for the add flow (`create`).
   */
  readonly location?: ScanLocation | null;
  /**
   * Fired after a successful create/update with the location id. The add flows
   * use it to kick off a scan of the just-saved folder (`scanner.refreshOne`).
   */
  readonly onSaved?: (id: number) => void;
}

const EMPTY_FORM: FormValues = {
  name: '',
  path: '',
  is_active: true,
  scan_recursive: true,
  description: '',
  content_format: ASSET_OPTION,
};

function formFromLocation(location: ScanLocation): FormValues {
  return {
    name: location.name,
    path: location.path,
    is_active: location.is_active,
    scan_recursive: location.scan_recursive,
    description: location.description ?? '',
    content_format: location.content_format ?? ASSET_OPTION,
  };
}

export function EditLocationModal({
  open,
  onOpenChange,
  location,
  onSaved,
}: EditLocationModalProps) {
  const utils = trpc.useUtils();
  const isEdit = location != null && location.id != null;

  const create = trpc.scanLocations.create.useMutation({
    onSuccess: (id) => {
      utils.scanLocations.list.invalidate();
      toast.success('Folder added');
      onOpenChange(false);
      onSaved?.(id);
    },
    onError: (err) => toast.error(err.message),
  });

  const update = trpc.scanLocations.update.useMutation({
    onSuccess: () => {
      utils.scanLocations.list.invalidate();
      utils.assets.invalidate();
      toast.success('Folder updated');
      onOpenChange(false);
      if (location?.id != null) onSaved?.(location.id);
    },
    onError: (err) => toast.error(err.message),
  });

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: EMPTY_FORM,
  });

  // Reset/prefill whenever the modal opens (or its target location changes) so
  // edit mode shows current values and add mode starts blank.
  useEffect(() => {
    if (!open) return;
    form.reset(location ? formFromLocation(location) : EMPTY_FORM);
  }, [open, location, form]);

  async function pickFolder() {
    const bridge = window.omnidex?.dialog?.openFolder;
    if (!bridge) return;
    const result = await bridge({ title: 'Pick an asset folder' });
    if (typeof result === 'string') {
      form.setValue('path', result);
      if (!form.getValues('name')) {
        const last = result.split(/[\\/]/).filter(Boolean).pop() ?? '';
        form.setValue('name', last);
      }
    }
  }

  function onSubmit(values: FormValues) {
    const description = values.description.length > 0 ? values.description : null;
    const contentFormat = values.content_format === ASSET_OPTION ? null : values.content_format;
    if (isEdit && location?.id != null) {
      update.mutate({
        id: location.id,
        name: values.name,
        path: values.path,
        is_active: values.is_active,
        scan_recursive: values.scan_recursive,
        description,
        content_format: contentFormat,
      });
      return;
    }
    create.mutate({
      name: values.name,
      path: values.path,
      is_active: values.is_active,
      scan_recursive: values.scan_recursive,
      description,
      last_scan: null,
      file_extensions: null,
      content_format: contentFormat,
    });
  }

  const pending = create.isPending || update.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Edit folder' : 'Add a folder'}</DialogTitle>
          <DialogDescription>
            Omnidex scans the folder recursively for UE packs and indexes every asset it finds.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="path">Folder path</Label>
            <div className="flex gap-2">
              <Input id="path" placeholder="E:/Library/Marketplace" {...form.register('path')} />
              <Button type="button" variant="secondary" onClick={pickFolder}>
                <Folder size={12} />
                Browse
              </Button>
            </div>
            {form.formState.errors.path ? (
              <span className="cap-10 text-danger-500">{form.formState.errors.path.message}</span>
            ) : null}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="name">Display name</Label>
            <Input id="name" placeholder="Marketplace" {...form.register('name')} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="description">Description (optional)</Label>
            <Input id="description" {...form.register('description')} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="content_format">Contains</Label>
            <Select
              value={form.watch('content_format')}
              onValueChange={(v) =>
                form.setValue('content_format', v as FormValues['content_format'])
              }
            >
              <SelectTrigger id="content_format">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ASSET_OPTION}>Assets (packs, models, materials)</SelectItem>
                {CONTENT_FORMATS.map((f) => (
                  <SelectItem key={f} value={f}>
                    {CONTENT_FORMAT_LABELS[f]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="cap-10 text-fg-muted">
              Anything other than Assets is indexed into the Learn tab instead of the library.
            </span>
          </div>
          <div className="flex items-center justify-between">
            <Label>Scan recursively</Label>
            <Switch
              checked={form.watch('scan_recursive')}
              onCheckedChange={(v) => form.setValue('scan_recursive', v)}
            />
          </div>
          <div className="flex items-center justify-between">
            <Label>Active</Label>
            <Switch
              checked={form.watch('is_active')}
              onCheckedChange={(v) => form.setValue('is_active', v)}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={pending}>
              {pending ? (isEdit ? 'Saving…' : 'Adding…') : isEdit ? 'Save changes' : 'Add folder'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
