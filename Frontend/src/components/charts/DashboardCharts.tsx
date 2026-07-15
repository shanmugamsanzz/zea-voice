/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, Legend, PieChart, Pie, Cell, BarChart, Bar, LineChart, Line } from 'recharts';
import { CALL_VOLUME_CHART_DATA, OUTCOME_DONUT_DATA, DURATION_BAR_DATA, LATENCY_TREND_DATA } from '../../lib/mockData';

// Custom Tooltip component for a premium look
const CustomTooltip = ({ active, payload, label }: any) => {
  if (active && payload && payload.length) {
    return (
      <div className="bg-white border border-gray-100 rounded-lg shadow-lg p-3 text-xs font-sans">
        <p className="font-semibold text-gray-800 mb-1">{label}</p>
        {payload.map((entry: any, index: number) => (
          <p key={index} style={{ color: entry.color }} className="font-medium">
            {entry.name}: {entry.value}
          </p>
        ))}
      </div>
    );
  }
  return null;
};

export function CallVolumeChart({ data = CALL_VOLUME_CHART_DATA }: { data?: Array<{ name: string; inbound: number; outbound: number }> }) {
  return (
    <div className="w-full h-80">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
          <defs>
            <linearGradient id="colorInbound" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#7C3AED" stopOpacity={0.2}/>
              <stop offset="95%" stopColor="#7C3AED" stopOpacity={0.0}/>
            </linearGradient>
            <linearGradient id="colorOutbound" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#EC4899" stopOpacity={0.2}/>
              <stop offset="95%" stopColor="#EC4899" stopOpacity={0.0}/>
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#F3F4F6" />
          <XAxis dataKey="name" stroke="#9CA3AF" fontSize={11} tickLine={false} />
          <YAxis stroke="#9CA3AF" fontSize={11} tickLine={false} />
          <Tooltip content={<CustomTooltip />} />
          <Legend iconType="circle" wrapperStyle={{ paddingTop: 10, fontSize: 12 }} />
          <Area type="monotone" name="Inbound Calls" dataKey="inbound" stroke="#7C3AED" strokeWidth={2} fillOpacity={1} fill="url(#colorInbound)" />
          <Area type="monotone" name="Outbound Calls" dataKey="outbound" stroke="#EC4899" strokeWidth={2} fillOpacity={1} fill="url(#colorOutbound)" />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

export function OutcomePieChart({ data = OUTCOME_DONUT_DATA }: { data?: Array<{ name: string; value: number; color: string }> }) {
  const total = data.reduce((sum, entry) => sum + entry.value, 0);
  return (
    <div className="w-full h-80 flex flex-col justify-between">
      <div className="h-60 w-full relative">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={data}
              cx="50%"
              cy="50%"
              innerRadius={65}
              outerRadius={85}
              paddingAngle={5}
              dataKey="value"
            >
              {data.map((entry, index) => (
                <Cell key={`cell-${index}`} fill={entry.color} />
              ))}
            </Pie>
            <Tooltip content={<CustomTooltip />} />
          </PieChart>
        </ResponsiveContainer>
        <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
          <span className="text-3xl font-bold text-gray-800">{total.toLocaleString()}</span>
          <span className="text-xs text-gray-400 font-medium">Calls</span>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2 text-xs font-sans px-4 mb-2">
        {data.map((entry, idx) => (
          <div key={idx} className="flex items-center space-x-2">
            <span className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: entry.color }} />
            <span className="text-gray-600 truncate">{entry.name} ({entry.value})</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function DurationBarChart({ data = DURATION_BAR_DATA }: { data?: Array<{ range: string; count: number }> }) {
  return (
    <div className="w-full h-80">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#F3F4F6" />
          <XAxis dataKey="range" stroke="#9CA3AF" fontSize={11} tickLine={false} />
          <YAxis stroke="#9CA3AF" fontSize={11} tickLine={false} />
          <Tooltip content={<CustomTooltip />} />
          <Bar name="Call Count" dataKey="count" fill="#7C3AED" radius={[4, 4, 0, 0]}>
            {data.map((entry, index) => (
              <Cell key={`cell-${index}`} fill={index % 2 === 0 ? '#7C3AED' : '#EC4899'} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function LatencyBreakdownChart() {
  return (
    <div className="w-full h-80">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={LATENCY_TREND_DATA} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#F3F4F6" />
          <XAxis dataKey="day" stroke="#9CA3AF" fontSize={11} tickLine={false} />
          <YAxis stroke="#9CA3AF" fontSize={11} tickLine={false} unit="ms" />
          <Tooltip content={<CustomTooltip />} />
          <Legend iconType="circle" wrapperStyle={{ paddingTop: 10, fontSize: 12 }} />
          <Area type="monotone" name="STT Latency (ms)" dataKey="stt" stackId="1" stroke="#3B82F6" fill="#3B82F6" fillOpacity={0.2} />
          <Area type="monotone" name="LLM Latency (ms)" dataKey="llm" stackId="1" stroke="#7C3AED" fill="#7C3AED" fillOpacity={0.2} />
          <Area type="monotone" name="TTS Latency (ms)" dataKey="tts" stackId="1" stroke="#EC4899" fill="#EC4899" fillOpacity={0.2} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
