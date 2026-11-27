import { LUADY_EFFORTS, type LuadyEffort, type Settings, managerName } from '@luady/shared';
import { useEffect, useState } from 'react';
import { useApi } from '../../api/context.js';
import { userMessage } from '../../api/errors.js';
import { useStore } from '../../state/store.js';
import { Banner } from '../../ui/Banner.js';
import { Button } from '../../ui/Button.js';
import { Card } from '../../ui/Card.js';
import { SelectField, Switch, TextField } from '../../ui/Field.js';
import { Spinner } from '../../ui/Spinner.js';
import { diffSettings, readNumber, validateSettings, withValue, type SettingsErrors } from './settings-form.js';

type NumberKey = 'escalate_after_min' | 'hook_wait_seconds' | 'finished_min_seconds' | 'call_rate_per_hour';
type TimeKey = 'graphify_time' | 'digest_time' | 'rotate_time';
type TextKey = 'manager_model' | 'voice_model';
type FlagKey = 'away' | 'night_calls' | 'phone_enabled';

interface FieldProps<K> {
  form: Settings;
  name: K;
  label: string;
  hint?: string;
  errors: SettingsErrors;
  onChange: (next: Settings) => void;
}

function NumberSetting({ form, name, label, hint, errors, onChange }: FieldProps<NumberKey>) {
  const value = form[name];
  return (
    <TextField label={label} hint={hint} error={errors[name]} type="number" inputMode="numeric"
      value={Number.isNaN(value) ? '' : String(value)} onChange={(event) => onChange(withValue(form, name, readNumber(event.target.value)))} />
  );
}

function TimeSetting({ form, name, label, hint, errors, onChange }: FieldProps<TimeKey>) {
  return <TextField label={label} hint={hint} error={errors[name]} type="time" value={form[name]}
    onChange={(event) => onChange(withValue(form, name, event.target.value))} />;
}

function TextSetting({ form, name, label, hint, errors, onChange }: FieldProps<TextKey>) {
  return <TextField label={label} hint={hint} error={errors[name]} value={form[name]} maxLength={64} autoCapitalize="off"
    spellCheck={false} onChange={(event) => onChange(withValue(form, name, event.target.value))} />;
}

const EFFORT_OPTIONS = LUADY_EFFORTS.map((value) => ({ value, label: value === 'max' ? 'max (deepest, slowest)' : value }));

function EffortSetting({ form, errors, onChange }: { form: Settings; errors: SettingsErrors; onChange: (next: Settings) => void }) {
  return <SelectField label={`${managerName()} thinking effort`} hint={`Higher thinks deeper but replies slower and uses more of the plan. Applies at the next ${managerName()} restart.`}
    error={errors.manager_effort} options={EFFORT_OPTIONS} value={form.manager_effort}
    onChange={(event) => onChange(withValue(form, 'manager_effort', event.target.value as LuadyEffort))} />;
}

function FlagSetting({ form, name, label, hint, onChange }: FieldProps<FlagKey>) {
  return <Switch label={label} description={hint} checked={form[name]} onChange={(next) => onChange(withValue(form, name, next))} />;
}

function QuietHours({ form, errors, onChange }: { form: Settings; errors: SettingsErrors; onChange: (next: Settings) => void }) {
  const set = (part: 'start' | 'end', value: string) => onChange({ ...form, quiet_hours: { ...form.quiet_hours, [part]: value } });
  return (
    <div className="settings-pair">
      <TextField label="Quiet hours start" type="time" value={form.quiet_hours.start} error={errors['quiet_hours.start']}
        onChange={(event) => set('start', event.target.value)} />
      <TextField label="Quiet hours end" type="time" value={form.quiet_hours.end} error={errors['quiet_hours.end']}
        onChange={(event) => set('end', event.target.value)} />
    </div>
  );
}

function SettingsFields({ form, errors, onChange }: { form: Settings; errors: SettingsErrors; onChange: (next: Settings) => void }) {
  const common = { form, errors, onChange };
  return (
    <>
      <section className="settings-section" aria-label="Notifications">
        <h3 className="section-title">Notifications</h3>
        <FlagSetting {...common} name="away" label="Away mode" hint="Report every finished turn on your chat channel, not only long ones." />
        <NumberSetting {...common} name="escalate_after_min" label="Call me after (minutes)" hint="An unanswered question triggers a call when the phone is on." />
        <NumberSetting {...common} name="finished_min_seconds" label="Report finished turns longer than (seconds)" />
        <QuietHours form={form} errors={errors} onChange={onChange} />
        <p className="text-subtle">Quiet hours are in owner time. Only questions notify during them.</p>
        <FlagSetting {...common} name="night_calls" label="Calls during quiet hours" hint="Allow escalation calls at night." />
      </section>
      <section className="settings-section" aria-label="Phone">
        <h3 className="section-title">Phone</h3>
        <FlagSetting {...common} name="phone_enabled" label="Phone calls" hint="Escalation calls and call-me callbacks through Twilio." />
        <NumberSetting {...common} name="call_rate_per_hour" label="Calls per hour (max)" />
      </section>
      <section className="settings-section" aria-label={`${managerName()} and schedule`}>
        <h3 className="section-title">{managerName()} and schedule</h3>
        <div className="settings-pair">
          <TextSetting {...common} name="manager_model" label={`${managerName()} model`} />
          <TextSetting {...common} name="voice_model" label="Voice model" />
        </div>
        <EffortSetting {...common} />
        <NumberSetting {...common} name="hook_wait_seconds" label="Hand questions back to the terminal after (seconds)" />
        <div className="settings-pair">
          <TimeSetting {...common} name="graphify_time" label="Graphify run" />
          <TimeSetting {...common} name="digest_time" label="Nightly digest" />
        </div>
        <TimeSetting {...common} name="rotate_time" label={`Daily ${managerName()} rotation`} />
      </section>
    </>
  );
}

/** The loaded settings (`base`), the edited copy (`form`) and a save that sends only the diff. */
function useSettingsDraft() {
  const api = useApi();
  const { toast } = useStore();
  const [base, setBase] = useState<Settings | null>(null);
  const [form, setForm] = useState<Settings | null>(null);
  const [errors, setErrors] = useState<SettingsErrors>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.settings().then(
      (loaded) => { if (!cancelled) { setBase(loaded); setForm(loaded); } },
      (err: unknown) => { if (!cancelled) setLoadError(userMessage(err)); },
    );
    return () => {
      cancelled = true;
    };
  }, [api]);

  async function save(current: Settings, original: Settings) {
    const found = validateSettings(current);
    setErrors(found);
    const patch = diffSettings(original, current);
    if (Object.keys(found).length > 0 || Object.keys(patch).length === 0) return;
    setSaving(true);
    try {
      const saved = await api.updateSettings(patch);
      setBase(saved);
      setForm(saved);
      toast('success', 'Settings saved');
    } catch (err) {
      toast('error', userMessage(err));
    } finally {
      setSaving(false);
    }
  }

  function discard() {
    setForm(base);
    setErrors({});
  }

  return { base, form, setForm, errors, loadError, saving, save, discard };
}

export function SettingsForm() {
  const { base, form, setForm, errors, loadError, saving, save, discard } = useSettingsDraft();
  if (loadError) return <Card title="Notifications and schedule"><Banner tone="error">{loadError}</Banner></Card>;
  if (!form || !base) return <Card title="Notifications and schedule"><Spinner label="Loading settings" /></Card>;
  const dirty = Object.keys(diffSettings(base, form)).length > 0;

  return (
    <Card title="Notifications and schedule">
      <form className="stack stack--lg" noValidate onSubmit={(event) => { event.preventDefault(); void save(form, base); }}>
        <SettingsFields form={form} errors={errors} onChange={setForm} />
        <div className="settings-savebar">
          <span className="text-subtle spacer">{dirty ? 'You have unsaved changes.' : 'All changes saved.'}</span>
          <Button variant="ghost" disabled={!dirty || saving} onClick={discard}>Discard</Button>
          <Button type="submit" variant="primary" busy={saving} disabled={!dirty}>Save settings</Button>
        </div>
      </form>
    </Card>
  );
}
