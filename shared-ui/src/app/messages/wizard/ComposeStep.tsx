import { useState } from 'react';
import type { ApiClient } from '../../../types.js';
import { describeError } from '../../ui/util.js';
import { CloseIcon, ImageIcon, SparklesIcon } from '../../ui/icons.js';
import { MAX_MESSAGE_CHARS, type MessageDraft } from './types.js';

export interface ComposeStepProps {
  api: ApiClient;
  draft: MessageDraft;
  onChange: (draft: MessageDraft) => void;
}

export function ComposeStep({ api, draft, onChange }: ComposeStepProps) {
  const [aiPrompt, setAiPrompt] = useState('');
  const [drafting, setDrafting] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);

  const [imagePrompt, setImagePrompt] = useState('');
  const [generating, setGenerating] = useState(false);
  const [imageError, setImageError] = useState<string | null>(null);

  async function writeWithAi() {
    const prompt = aiPrompt.trim();
    if (!prompt || drafting) return;
    setDrafting(true);
    setDraftError(null);
    try {
      const text = await api.draftMessage(prompt);
      onChange({ ...draft, text: text.slice(0, MAX_MESSAGE_CHARS) });
    } catch (err) {
      setDraftError(describeError(err));
    } finally {
      setDrafting(false);
    }
  }

  async function generateImage() {
    const prompt = imagePrompt.trim();
    if (!prompt || generating) return;
    setGenerating(true);
    setImageError(null);
    try {
      const result = await api.generateImage(prompt);
      onChange({ ...draft, imageEnabled: true, image: { sessionId: result.sessionId, path: result.path, previewUrl: result.signedUrl } });
    } catch (err) {
      setImageError(describeError(err));
    } finally {
      setGenerating(false);
    }
  }

  return (
    <div className="stack">
      <div>
        <h1 className="section-title">Create your message</h1>
        <p className="section-subtitle">Write it yourself or describe it and let AI draft it.</p>
      </div>

      <section className="card stack">
        <div className="row">
          <SparklesIcon size={18} />
          <div>
            <div className="card__title">Write with AI</div>
            <div className="card__subtitle">Describe what you want to say. You can edit the result.</div>
          </div>
        </div>
        <div className="ai-row">
          <input
            className="input"
            placeholder="e.g. Invite customers to our weekend sale"
            value={aiPrompt}
            onChange={(e) => setAiPrompt(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && writeWithAi()}
          />
          <button className="btn btn--secondary" onClick={writeWithAi} disabled={!aiPrompt.trim() || drafting}>
            {drafting ? <span className="spinner" /> : 'Generate'}
          </button>
        </div>
        {draftError && <div className="alert alert--error">{draftError}</div>}
      </section>

      <section className="card">
        <label className="field">
          <span className="field__label">Message</span>
          <textarea
            className="textarea"
            placeholder="Type your message…"
            value={draft.text}
            maxLength={MAX_MESSAGE_CHARS}
            onChange={(e) => onChange({ ...draft, text: e.target.value })}
          />
          <span className="char-count">
            {draft.text.length} / {MAX_MESSAGE_CHARS}
          </span>
        </label>
      </section>

      <section className="card stack">
        <div className="row row--between">
          <div className="row">
            <ImageIcon size={18} />
            <div>
              <div className="card__title">Add an image</div>
              <div className="card__subtitle">Optional. Generated from your description.</div>
            </div>
          </div>
          <button
            className="switch"
            role="switch"
            aria-checked={draft.imageEnabled}
            aria-label="Add an image"
            onClick={() => onChange({ ...draft, imageEnabled: !draft.imageEnabled })}
          />
        </div>

        {draft.imageEnabled && (
          <>
            <div className="ai-row">
              <input
                className="input"
                placeholder="Describe the image"
                value={imagePrompt}
                onChange={(e) => setImagePrompt(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && generateImage()}
              />
              <button className="btn btn--secondary" onClick={generateImage} disabled={!imagePrompt.trim() || generating}>
                {generating ? <span className="spinner" /> : draft.image ? 'Regenerate' : 'Generate'}
              </button>
            </div>
            <div className="image-preview">
              {draft.image ? (
                <>
                  <img src={draft.image.previewUrl} alt="Generated image" />
                  <button
                    className="icon-btn"
                    aria-label="Remove image"
                    style={{ position: 'absolute', top: 8, right: 8, background: 'rgba(255,255,255,0.9)' }}
                    onClick={() => onChange({ ...draft, image: null })}
                  >
                    <CloseIcon size={18} />
                  </button>
                </>
              ) : (
                <div className="image-placeholder">
                  {generating ? <span className="spinner" /> : <ImageIcon size={28} />}
                  <span>{generating ? 'Generating image…' : 'Your image will appear here'}</span>
                </div>
              )}
            </div>
            {imageError && <div className="alert alert--error">{imageError}</div>}
          </>
        )}
      </section>
    </div>
  );
}
