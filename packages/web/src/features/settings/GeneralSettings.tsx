import { type Settings } from '@luady/shared';
import { useEffect, useMemo, useState } from 'react';
import { useApi } from '../../api/context.js';
import { userMessage } from '../../api/errors.js';
import { usePin } from '../../pin/PinProvider.js';
import { useStore } from '../../state/store.js';
import { Banner } from '../../ui/Banner.js';
import { Button } from '../../ui/Button.js';
import { Card } from '../../ui/Card.js';
import { SelectField, Switch, TextField } from '../../ui/Field.js';
import { Spinner } from '../../ui/Spinner.js';
import {
  NIGHTLY_SWITCHES, browserZone, generalOf, generalPatch, unsetZoneLabel, unsetZoneLine, validateGeneral, zoneOptions,
  type GeneralErrors, type GeneralFields,
} from './general-settings.js';
import { ManagerSwitch } from './ManagerSwitch.js';
import { managerSwitchApi } from './manager-switch-api.js';

interface ZonePickerProps {
  readonly form: GeneralFields;
  /** The zone the hub has stored (null: none yet). */
  readonly stored: string | null;
  readonly error?: string | undefined;
  readonly saving: boolean;
  onChange(zone: string): void;
  /** Saves a zone at once (the one button while none is stored). */
  onSave(zone: string): void;
}

function ZonePicker({ form, stored, error, saving, onChange, onSave }: ZonePickerProps) {
  const options = useMemo(() => zoneOptions(form.owner_tz).map((zone) => ({ value: zone, label: zone })), [form.owner_tz]);
  const mine = browserZone();
  return (
    <div className="stack">
      <SelectField label="Your time zone" hint="Every time the hub shows you, and the nightly jobs, follow it." error={error}
        options={[{ value: '', label: unsetZoneLabel(mine), disabled: true }, ...options]} value={form.owner_tz ?? ''}
        onChange={(event) => onChange(event.target.value)} />
      {stored === null ? (
        <div className="stack" data-testid="zone-unset">
          <p className="text-muted">{unsetZoneLine(mine)}</p>
          {mine !== null ? (
            <Button variant="secondary" busy={saving} onClick={() => onSave(mine)}>Save {mine} as my time zone</Button>
          ) : null}
        </div>
      ) : mine !== null && mine !== form.owner_tz ? (
        <Button variant="ghost" onClick={() => onChange(mine)}>Use this browser's zone ({mine})</Button>
      ) : null}
    </div>
  );
}

/** require_pin: turning it off asks for the PIN here; the settings route checks it. */
function PinRule({ form, onSaved }: { form: GeneralFields; onSaved: (settings: Settings) => void }) {
  const api = useApi();
  const { runPinned } = usePin();
  const { toast } = useStore();
  async function change(next: boolean) {
    try {
      if (next) {
        onSaved(await api.updateSettings({ require_pin: true }));
        return;
      }
      const saved = await runPinned((pin) => managerSwitchApi.requirePinOff(pin ?? '', api.csrf()), {
        require: true, title: 'Stop asking for the PIN', detail: 'The manager\'s risky actions would then run without your PIN.',
      });
      if (saved !== null) onSaved(saved);
    } catch (err) {
      toast('error', userMessage(err));
    }
  }
  return (
    <Switch label="Ask for my PIN before the manager's risky actions" checked={form.require_pin} onChange={(next) => void change(next)}
      description="Commands on your servers, file changes and restarts wait for your PIN. Turning this off needs the PIN." />
  );
}

/** The loaded settings, the edited copy, and a save that sends only what changed. */
function useGeneralDraft() {
  const api = useApi();
  const { toast } = useStore();
  const [base, setBase] = useState<Settings | null>(null);
  const [form, setForm] = useState<GeneralFields | null>(null);
  const [errors, setErrors] = useState<GeneralErrors>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let live = true;
    api.settings().then(
      (loaded) => {
        if (!live) return;
        setBase(loaded);
        setForm(generalOf(loaded));
      },
      (err: unknown) => {
        if (live) setLoadError(userMessage(err));
      },
    );
    return () => {
      live = false;
    };
  }, [api]);

  function adopt(saved: Settings) {
    setBase(saved);
    setForm(generalOf(saved));
  }

  async function save() {
    if (base === null || form === null) return;
    const found = validateGeneral(form);
    setErrors(found);
    const patch = generalPatch(generalOf(base), form);
    if (Object.keys(found).length > 0 || Object.keys(patch).length === 0) return;
    setSaving(true);
    try {
      adopt(await api.updateSettings({ ...patch, ...(patch.manager_name === undefined ? {} : { manager_name: patch.manager_name.trim() }) }));
      toast('success', 'Settings saved');
    } catch (err) {
      toast('error', userMessage(err));
    } finally {
      setSaving(false);
    }
  }

  /** The one-button save of a zone while none is stored; other unsaved edits on the page stay as they are. */
  async function saveZone(zone: string) {
    setSaving(true);
    try {
      const saved = await api.updateSettings({ owner_tz: zone });
      setBase(saved);
      setForm((current) => (current === null ? generalOf(saved) : { ...current, owner_tz: saved.owner_tz }));
      toast('success', 'Time zone saved');
    } catch (err) {
      toast('error', userMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return { base, form, setForm, errors, loadError, saving, save, saveZone, adopt };
}

/** General settings: the owner's zone, the manager and its name, the PIN rule and the five nightly switches. */
export function GeneralSettings() {
  const { base, form, setForm, errors, loadError, saving, save, saveZone, adopt } = useGeneralDraft();
  if (loadError !== null) return <Card title="General"><Banner tone="error">{loadError}</Banner></Card>;
  if (base === null || form === null) return <Card title="General"><Spinner label="Loading settings" /></Card>;
  const dirty = Object.keys(generalPatch(generalOf(base), form)).length > 0;
  const set = <K extends keyof GeneralFields>(key: K, value: GeneralFields[K]) => setForm({ ...form, [key]: value });

  return (
    <Card title="General">
      <form className="stack stack--lg" noValidate data-testid="settings-general" onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <ZonePicker form={form} stored={base.owner_tz} error={errors.owner_tz} saving={saving}
          onChange={(zone) => set('owner_tz', zone)} onSave={(zone) => void saveZone(zone)} />
        <section className="settings-section" aria-label="The manager">
          <h3 className="section-title">The manager</h3>
          <ManagerSwitch />
          <TextField label="The manager's name" hint="How the manager is called in chat, notices and on the map." error={errors.manager_name}
            value={form.manager_name} maxLength={40} onChange={(event) => set('manager_name', event.target.value)} />
          <PinRule form={form} onSaved={adopt} />
        </section>
        <section className="settings-section" aria-label="Nightly jobs">
          <h3 className="section-title">Nightly jobs</h3>
          {NIGHTLY_SWITCHES.map((job) => (
            <Switch key={job.key} label={job.label} checked={form[job.key]} onChange={(next) => set(job.key, next)}
              description={`${job.line(base)}${job.needsManager ? ' Needs the manager.' : ''}`} />
          ))}
        </section>
        <div className="settings-savebar">
          <span className="text-subtle spacer">{dirty ? 'You have unsaved changes.' : 'All changes saved.'}</span>
          <Button variant="ghost" disabled={!dirty || saving} onClick={() => setForm(generalOf(base))}>Discard</Button>
          <Button type="submit" variant="primary" busy={saving} disabled={!dirty}>Save</Button>
        </div>
      </form>
    </Card>
  );
}
