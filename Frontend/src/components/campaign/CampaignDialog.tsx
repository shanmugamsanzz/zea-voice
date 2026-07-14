/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { useAppState } from '../../store/AppState';
import { MOCK_AGENTS, MOCK_PHONE_NUMBERS } from '../../lib/mockData';
import { Campaign } from '../../types';
import { Megaphone, Save, X, Plus, Calendar, AlertTriangle, Layers } from 'lucide-react';

interface CampaignDialogProps {
  onSave: (campaign: Campaign) => void;
  onClose: () => void;
}

export function CampaignDialog({ onSave, onClose }: CampaignDialogProps) {
  const [name, setName] = useState('');
  const [selectedAgentId, setSelectedAgentId] = useState(MOCK_AGENTS[0]?.id || '');
  const [selectedNumId, setSelectedNumId] = useState(MOCK_PHONE_NUMBERS[0]?.id || '');
  const [totalLeads, setTotalLeads] = useState(100);
  const [concurrency, setConcurrency] = useState(3);
  const [csvLeads, setCsvLeads] = useState('First Name,Phone,Company\nAlice,+13125849301,Acme LLC\nBob,+18882931029,Initech Inc');
  const [scheduleStart, setScheduleStart] = useState('2026-07-15 09:00');
  const [scheduleEnd, setScheduleEnd] = useState('2026-08-15 17:00');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setErrorMsg('Please specify a Campaign Name.');
      return;
    }

    const agent = MOCK_AGENTS.find(a => a.id === selectedAgentId);
    const num = MOCK_PHONE_NUMBERS.find(n => n.id === selectedNumId);

    onSave({
      id: `camp-${Date.now()}`,
      name,
      status: 'scheduled',
      agentId: selectedAgentId,
      agentName: agent ? agent.name : 'Unknown Agent',
      phoneNumberId: selectedNumId,
      phoneNumber: num ? num.number : '+1 (555) 0123',
      totalLeads,
      calledLeads: 0,
      connectedCalls: 0,
      convertedCount: 0,
      scheduleStart,
      scheduleEnd
    });
  };

  return (
    <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-xs flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl max-w-2xl w-full border border-slate-100 overflow-hidden animate-in fade-in zoom-in-95 duration-150">
        <div className="bg-gradient-to-r from-violet-600 to-indigo-600 px-6 py-4 flex items-center justify-between text-white">
          <div className="flex items-center space-x-2">
            <Megaphone className="w-5 h-5 text-violet-100" />
            <h3 className="font-bold text-lg tracking-tight">Schedule Outbound Dialer Campaign</h3>
          </div>
          <button onClick={onClose} className="p-1.5 hover:bg-white/15 rounded-lg text-white/80 hover:text-white transition">
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-5">
          {errorMsg && (
            <div className="p-3 bg-red-50 border border-red-100 text-red-800 rounded-lg text-xs font-semibold flex items-center space-x-2">
              <AlertTriangle className="w-4 h-4 text-red-600" />
              <span>{errorMsg}</span>
            </div>
          )}

          {/* Form Rows */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-[11px] font-bold text-slate-500 uppercase mb-1.5">Campaign Name</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Q3 Feedback Outbound Survey"
                className="w-full bg-slate-50 border border-slate-200 focus:bg-white focus:border-violet-500 rounded-xl px-4 py-2 text-xs font-semibold text-slate-800 transition outline-none"
              />
            </div>

            <div>
              <label className="block text-[11px] font-bold text-slate-500 uppercase mb-1.5">Voice Agent to Instruct</label>
              <select
                value={selectedAgentId}
                onChange={(e) => setSelectedAgentId(e.target.value)}
                className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-2.5 text-xs font-semibold text-slate-800 outline-none"
              >
                {MOCK_AGENTS.map(agent => (
                  <option key={agent.id} value={agent.id}>{agent.name}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-[11px] font-bold text-slate-500 uppercase mb-1.5">Caller ID Number</label>
              <select
                value={selectedNumId}
                onChange={(e) => setSelectedNumId(e.target.value)}
                className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-2.5 text-xs font-semibold text-slate-800 outline-none"
              >
                {MOCK_PHONE_NUMBERS.map(num => (
                  <option key={num.id} value={num.id}>{num.number} ({num.provider})</option>
                ))}
              </select>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-[11px] font-bold text-slate-500 uppercase mb-1.5">Lead Cap</label>
                <input
                  type="number"
                  value={totalLeads}
                  onChange={(e) => setTotalLeads(parseInt(e.target.value))}
                  className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-2 text-xs font-semibold text-slate-800 outline-none"
                />
              </div>
              <div>
                <label className="block text-[11px] font-bold text-slate-500 uppercase mb-1.5">Dial Concurrency</label>
                <select
                  value={concurrency}
                  onChange={(e) => setConcurrency(parseInt(e.target.value))}
                  className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-2.5 text-xs font-semibold text-slate-800 outline-none"
                >
                  <option value={1}>1 Outbound Channel</option>
                  <option value={3}>3 Concurrent Channels</option>
                  <option value={5}>5 Concurrent Channels</option>
                  <option value={10}>10 Concurrent (Enterprise)</option>
                </select>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-[11px] font-bold text-slate-500 uppercase mb-1.5">Schedule Dialing Start</label>
              <div className="relative">
                <input
                  type="text"
                  value={scheduleStart}
                  onChange={(e) => setScheduleStart(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-2 text-xs font-semibold text-slate-800 outline-none"
                />
                <Calendar className="w-3.5 h-3.5 text-slate-400 absolute right-3.5 top-3" />
              </div>
            </div>

            <div>
              <label className="block text-[11px] font-bold text-slate-500 uppercase mb-1.5">Schedule Dialing End</label>
              <div className="relative">
                <input
                  type="text"
                  value={scheduleEnd}
                  onChange={(e) => setScheduleEnd(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-2 text-xs font-semibold text-slate-800 outline-none"
                />
                <Calendar className="w-3.5 h-3.5 text-slate-400 absolute right-3.5 top-3" />
              </div>
            </div>
          </div>

          <div>
            <label className="block text-[11px] font-bold text-slate-500 uppercase mb-1.5">CSV Lead Paste List</label>
            <textarea
              rows={3}
              value={csvLeads}
              onChange={(e) => setCsvLeads(e.target.value)}
              className="w-full bg-slate-50 border border-slate-200 focus:bg-white focus:border-violet-500 rounded-xl p-3 text-xs font-mono text-slate-700 outline-none"
              placeholder="First Name,Phone,Company"
            />
            <span className="text-[10px] text-slate-400 mt-1 block">Specify column headers. These will map automatically to template tags.</span>
          </div>

          <div className="pt-4 border-t border-slate-100 flex items-center justify-end space-x-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 bg-slate-50 hover:bg-slate-100 text-slate-600 rounded-xl text-xs font-bold transition"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-5 py-2 bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-700 hover:to-indigo-700 text-white rounded-xl text-xs font-bold transition shadow-sm flex items-center space-x-1.5"
            >
              <Megaphone className="w-3.5 h-3.5" />
              <span>Deploy Outbound Campaign</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
