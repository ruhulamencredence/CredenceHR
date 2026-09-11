/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef, useState } from 'react';
import { ChevronLeft, Camera, User as UserIcon, Briefcase, Building2, MapPin, AlertCircle } from 'lucide-react';
import { apiUrl } from '../lib/api';
import { Spinner } from './Spinner';

interface PersonalDataFormProps {
  token: string;
  onBack: () => void;
  // Called once Update succeeds, with the new "First Last" full name, so the
  // caller (ProfilePage -> App) can refresh the name shown in the header,
  // sidebar, and everywhere else `user.name` is used.
  onSaved: (fullName: string) => void;
  // Called right after a photo upload succeeds, so the caller (ProfilePage ->
  // App) can bump its photoVersion counter and refresh the Navbar/
  // GlobalSidebar avatar immediately instead of waiting for a page reload.
  onPhotoUpdated?: () => void;
}

interface PersonalData {
  first_name: string;
  last_name: string;
  date_of_birth: string | null;
  country: string | null;
  state: string | null;
  city: string | null;
  full_address: string | null;
  has_photo: boolean;
  position: string | null;
  department: string | null;
}

const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

// Converts a File to a base64 string (no "data:...;base64," prefix), the same
// FileReader -> base64 approach already used for Conveyance Bill Claim
// attachments and Budget Excel imports elsewhere in this app.
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      resolve(result.split(',')[1] || '');
    };
    reader.onerror = () => reject(new Error('Could not read the selected file.'));
    reader.readAsDataURL(file);
  });
}

// My Personal Data — reachable from ProfilePage's "Personal Data" row.
// First Name/Last Name/Date of Birth/Address/Photo are editable and saved to
// user_profile_details (see profileRoutes.ts). Position and Department are
// shown read-only, synced live from the linked Employees record (all_employees
// via user_id) so this form never holds a second, driftable copy of either.
export const PersonalDataForm: React.FC<PersonalDataFormProps> = ({ token, onBack, onSaved, onPhotoUpdated }) => {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const objectUrlRef = useRef<string | null>(null);

  const [data, setData] = useState<PersonalData>({
    first_name: '',
    last_name: '',
    date_of_birth: null,
    country: null,
    state: null,
    city: null,
    full_address: null,
    has_photo: false,
    position: null,
    department: null
  });

  const authHeaders = { Authorization: `Bearer ${token}` };

  const loadPhoto = async () => {
    try {
      const res = await fetch(apiUrl('/api/profile/photo'), { headers: authHeaders });
      if (!res.ok) return;
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = url;
      setPhotoUrl(url);
    } catch {
      // No photo yet, or offline — the placeholder avatar stays up.
    }
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(apiUrl('/api/profile/personal-data'), { headers: authHeaders });
        if (!res.ok) throw new Error('Could not load your Personal Data.');
        const json = await res.json();
        if (cancelled) return;
        setData(json);
        if (json.has_photo) await loadPhoto();
      } catch (err: any) {
        if (!cancelled) setError(err.message || 'Could not load your Personal Data.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const handlePhotoPick = () => fileInputRef.current?.click();

  const handlePhotoChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError(null);

    if (!/^image\/(jpeg|jpg|png)$/i.test(file.type)) {
      setError('Photo must be a JPEG or PNG image.');
      return;
    }
    if (file.size > MAX_PHOTO_BYTES) {
      setError('Photo must be less than 5MB.');
      return;
    }

    setUploadingPhoto(true);
    try {
      const base64 = await fileToBase64(file);
      const res = await fetch(apiUrl('/api/profile/photo'), {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ photo_base64: base64, photo_mimetype: file.type })
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'Could not upload the photo.');

      // Show the picked file immediately rather than waiting on a round-trip
      // GET — same instant-preview approach as elsewhere in the app.
      const localUrl = URL.createObjectURL(file);
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = localUrl;
      setPhotoUrl(localUrl);
      setData((prev) => ({ ...prev, has_photo: true }));
      onPhotoUpdated?.();
    } catch (err: any) {
      setError(err.message || 'Could not upload the photo.');
    } finally {
      setUploadingPhoto(false);
    }
  };

  const update = (field: keyof PersonalData) => (
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>
  ) => setData((prev) => ({ ...prev, [field]: e.target.value }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!data.first_name.trim() || !data.last_name.trim()) {
      setError('First Name and Last Name are required.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(apiUrl('/api/profile/personal-data'), {
        method: 'PUT',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          first_name: data.first_name.trim(),
          last_name: data.last_name.trim(),
          date_of_birth: data.date_of_birth || null,
          country: data.country || null,
          state: data.state || null,
          city: data.city || null,
          full_address: data.full_address || null
        })
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'Could not save your Personal Data.');
      onSaved(json.name || `${data.first_name.trim()} ${data.last_name.trim()}`.trim());
      onBack();
    } catch (err: any) {
      setError(err.message || 'Could not save your Personal Data.');
    } finally {
      setSaving(false);
    }
  };

  const initial = (data.first_name || '?').trim().charAt(0).toUpperCase();

  return (
    <div className="w-full min-h-[calc(100vh-4rem)]" style={{ background: 'var(--g-surface-muted)' }}>
      <div className="max-w-lg mx-auto px-4 pt-3 pb-28">
        <div className="flex items-center gap-2 mb-3">
          <button
            type="button"
            onClick={onBack}
            className="w-9 h-9 rounded-full flex items-center justify-center hover:bg-black/5 transition-colors"
            style={{ color: 'var(--g-text-muted)' }}
            aria-label="Back"
          >
            <ChevronLeft className="w-5 h-5" />
          </button>
          <h1 className="text-base font-bold">Personal Data</h1>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-20">
            <Spinner size={28} />
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            {error && (
              <div className="flex items-start gap-2 text-sm px-3 py-2.5 rounded-xl bg-rose-50 text-rose-700 border border-rose-200">
                <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <section className="gemini-card p-4">
              <p className="text-sm font-bold">My Personal Data</p>
              <p className="text-xs mb-4" style={{ color: 'var(--g-text-muted)' }}>
                Details about my personal data
              </p>

              <div className="flex flex-col items-center mb-5">
                <div className="relative">
                  <div
                    className="w-20 h-20 rounded-full flex items-center justify-center text-2xl font-semibold overflow-hidden"
                    style={{ background: 'var(--g-accent-soft)', color: 'var(--g-accent)' }}
                  >
                    {photoUrl ? (
                      <img src={photoUrl} alt="Profile" className="w-full h-full object-cover" />
                    ) : (
                      initial
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={handlePhotoPick}
                    disabled={uploadingPhoto}
                    className="absolute -bottom-0.5 -right-0.5 w-7 h-7 rounded-full flex items-center justify-center text-white shadow-sm"
                    style={{ background: 'var(--g-accent)' }}
                    aria-label="Upload Photo"
                  >
                    {uploadingPhoto ? <Spinner size={14} className="text-white" /> : <Camera className="w-3.5 h-3.5" />}
                  </button>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/jpeg,image/png"
                    className="hidden"
                    onChange={handlePhotoChange}
                  />
                </div>
                <p className="text-xs font-medium mt-2">Upload Photo</p>
                <p className="text-[11px] text-center mt-0.5" style={{ color: 'var(--g-text-muted)' }}>
                  JPEG or PNG, at least 800×800px and less than 5MB
                </p>
              </div>

              <div className="space-y-3">
                <Field label="First Name" icon={<UserIcon className="w-4 h-4" />}>
                  <input
                    type="text"
                    value={data.first_name}
                    onChange={update('first_name')}
                    required
                    className="profile-field-input"
                    placeholder="First Name"
                  />
                </Field>
                <Field label="Last Name" icon={<UserIcon className="w-4 h-4" />}>
                  <input
                    type="text"
                    value={data.last_name}
                    onChange={update('last_name')}
                    required
                    className="profile-field-input"
                    placeholder="Last Name"
                  />
                </Field>
                <Field label="Date of Birth" icon={<UserIcon className="w-4 h-4" />}>
                  <input
                    type="date"
                    value={data.date_of_birth || ''}
                    onChange={update('date_of_birth')}
                    className="profile-field-input"
                  />
                </Field>
                <Field label="Position" icon={<Briefcase className="w-4 h-4" />} readOnly>
                  <span className="profile-field-input profile-field-readonly">
                    {data.position || 'Not linked to an Employee record'}
                  </span>
                </Field>
                <Field label="Department" icon={<Building2 className="w-4 h-4" />} readOnly>
                  <span className="profile-field-input profile-field-readonly">
                    {data.department || 'Not linked to an Employee record'}
                  </span>
                </Field>
              </div>
            </section>

            <section className="gemini-card p-4">
              <p className="text-sm font-bold">Address</p>
              <p className="text-xs mb-4" style={{ color: 'var(--g-text-muted)' }}>
                Your current domicile
              </p>
              <div className="space-y-3">
                <Field label="Country" icon={<MapPin className="w-4 h-4" />}>
                  <input
                    type="text"
                    value={data.country || ''}
                    onChange={update('country')}
                    className="profile-field-input"
                    placeholder="Country"
                  />
                </Field>
                <Field label="State" icon={<MapPin className="w-4 h-4" />}>
                  <input
                    type="text"
                    value={data.state || ''}
                    onChange={update('state')}
                    className="profile-field-input"
                    placeholder="State / Division"
                  />
                </Field>
                <Field label="City" icon={<MapPin className="w-4 h-4" />}>
                  <input
                    type="text"
                    value={data.city || ''}
                    onChange={update('city')}
                    className="profile-field-input"
                    placeholder="City"
                  />
                </Field>
                <div>
                  <label className="text-xs mb-1 block" style={{ color: 'var(--g-text-muted)' }}>
                    Full Address
                  </label>
                  <div className="profile-field-box items-start">
                    <MapPin className="w-4 h-4 mt-0.5 shrink-0" style={{ color: 'var(--g-accent)' }} />
                    <textarea
                      value={data.full_address || ''}
                      onChange={update('full_address')}
                      rows={3}
                      className="profile-field-input resize-none"
                      placeholder="Full Address"
                    />
                  </div>
                </div>
              </div>
            </section>

            <div className="fixed bottom-0 left-0 right-0 p-4 bg-gradient-to-t from-white via-white/95 to-transparent">
              <div className="max-w-lg mx-auto">
                <button
                  type="submit"
                  disabled={saving}
                  className="w-full py-3 rounded-full text-white text-sm font-semibold shadow-sm disabled:opacity-60 flex items-center justify-center gap-2"
                  style={{ background: 'linear-gradient(90deg, #7F00FF, #6300C6)' }}
                >
                  {saving && <Spinner size={16} className="text-white" />}
                  Update
                </button>
              </div>
            </div>
          </form>
        )}
      </div>
    </div>
  );
};

const Field: React.FC<{ label: string; icon: React.ReactNode; readOnly?: boolean; children: React.ReactNode }> = ({
  label,
  icon,
  children
}) => (
  <div>
    <label className="text-xs mb-1 block" style={{ color: 'var(--g-text-muted)' }}>
      {label}
    </label>
    <div className="profile-field-box">
      <span className="shrink-0" style={{ color: 'var(--g-accent)' }}>
        {icon}
      </span>
      {children}
    </div>
  </div>
);