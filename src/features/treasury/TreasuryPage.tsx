import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {Building, Info, ArrowLeft} from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Input } from '@/components/ui/Input'
import { useAuthStore } from '@/store'
import { useMediaQuery } from '@/hooks/useMediaQuery'

// Arc uses Proof of Authority — public staking not available on testnet
// These are informational validators from Arc's PoA network
const ARC_VALIDATORS = [
  { id: 'v1', name: 'Arc Validator Node 1', apy: 8.5, uptime: 99.9, status: 'active' },
  { id: 'v2', name: 'Arc Validator Node 2', apy: 8.2, uptime: 99.8, status: 'active' },
  { id: 'v3', name: 'Arc Validator Node 3', apy: 8.7, uptime: 99.95, status: 'active' },
]

export function TreasuryPage() {
  const isDesktop = useMediaQuery('(min-width: 980px)')
  const navigate = useNavigate()
  const walletAddress = useAuthStore(s => s.walletAddress)
  const [selectedValidator, setSelectedValidator] = useState<string | null>(null)
  const [stakeAmount, setStakeAmount] = useState('')
  const [activeTab, setActiveTab] = useState<'stake' | 'unstake'>('stake')

  return (
    <div className="flex flex-col h-screen bg-bg overflow-hidden lg:max-w-[720px]">
      <div className="header-row sticky top-0 z-20 backdrop-blur-md bg-bg/95 flex-shrink-0 gap-2 px-5 pt-header pb-header">
        {!isDesktop && (
          <button onClick={() => navigate('/')} className="back-btn">
            <ArrowLeft className="w-5 h-5 text-text-primary" />
          </button>
        )}
        <h1 className="text-xl font-bold text-text-primary">Treasury</h1>
      </div>

      <div className="flex-1 overflow-y-auto">
      <div className="px-4 space-y-4 pb-8">
        {/* Info banner */}
        <div className="flex items-start gap-3 p-4 bg-brand/10 border border-brand/30 rounded-2xl">
          <Info className="w-5 h-5 text-brand flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-semibold text-brand">Arc Testnet — Staking Preview</p>
            <p className="text-xs text-text-secondary mt-1">
              Arc uses Proof of Authority. Public staking launches with mainnet. 
              Stake/unstake UI is available for testing.
            </p>
          </div>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-3 gap-3">
          {[
            { label: 'My Staked', value: '0 USDC' },
            { label: 'Rewards', value: '0 USDC' },
            { label: 'Avg APY', value: '8.5%' },
          ].map(s => (
            <Card key={s.label} className="p-3 text-center">
              <p className="text-xs text-text-secondary mb-1">{s.label}</p>
              <p className="text-sm font-bold text-text-primary">{s.value}</p>
            </Card>
          ))}
        </div>

        {/* Validators */}
        <div>
          <p className="text-xs font-bold text-text-secondary uppercase tracking-wider mb-3">Validators</p>
          <div className="space-y-2">
            {ARC_VALIDATORS.map(v => (
              <button key={v.id} onClick={() => setSelectedValidator(selectedValidator === v.id ? null : v.id)}
                className={`w-full p-4 rounded-2xl border text-left transition-colors ${
                  selectedValidator === v.id ? 'bg-brand/20 border-brand/50' : 'bg-surface border-border hover:border-[rgb(var(--text-primary-rgb)/0.10)]'
                }`}>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 bg-brand/20 rounded-xl flex items-center justify-center">
                      <Building className="w-5 h-5 text-brand" />
                    </div>
                    <div>
                      <p className="text-sm font-semibold text-text-primary">{v.name}</p>
                      <p className="text-xs text-text-secondary">Uptime: {v.uptime}%</p>
                    </div>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-bold text-success">{v.apy}% APY</p>
                    <div className="flex items-center gap-1 justify-end mt-0.5">
                      <div className="w-1.5 h-1.5 bg-success rounded-full" />
                      <p className="text-xs text-success">Active</p>
                    </div>
                  </div>
                </div>

                <AnimatePresence>
                  {selectedValidator === v.id && (
                    <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }}
                      exit={{ opacity: 0, height: 0 }}
                      className="overflow-hidden">
                      <div className="mt-4 space-y-3">
                        <div className="flex bg-surface rounded-xl p-1">
                          <button onClick={e => { e.stopPropagation(); setActiveTab('stake') }}
                            className={`flex-1 py-2 rounded-lg text-sm font-semibold ${activeTab === 'stake' ? 'bg-brand text-white' : 'text-text-secondary'}`}>
                            Stake
                          </button>
                          <button onClick={e => { e.stopPropagation(); setActiveTab('unstake') }}
                            className={`flex-1 py-2 rounded-lg text-sm font-semibold ${activeTab === 'unstake' ? 'bg-brand text-white' : 'text-text-secondary'}`}>
                            Unstake
                          </button>
                        </div>
                        <div onClick={e => e.stopPropagation()}>
                          <Input placeholder="Amount (USDC)" value={stakeAmount}
                            onChange={e => setStakeAmount(e.target.value)} type="number" />
                        </div>
                        <Button fullWidth onClick={e => { e.stopPropagation() }}>
                          {activeTab === 'stake' ? `Stake ${stakeAmount || '0'} USDC` : `Unstake ${stakeAmount || '0'} USDC`}
                        </Button>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
      </div>
  )
}