/** Run page — two tabs:
 *   - 启动 (Launch): pick a dsh, then start any of its profiles from a tile grid.
 *     A tile's play icon launches with saved parameters; its "…" icon opens the
 *     launch dialog to configure them.
 *   - 进程管理 (Processes): a two-pane view (process rail + console) for every
 *     live run, plus runs that ended this session.
 *
 * Concurrency model (see docs/design/multi-run.md): different (dsh, profile)
 * pairs run in parallel; the same pair is limited to one live process. */

import { useEffect, useState, type ReactNode } from 'react'
import { Button, Modal, Select, Space, Spin, Tabs, Tag, Tooltip, theme } from 'antd'
import { MoreOutlined, PlayCircleOutlined, RocketOutlined, UnorderedListOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import AppShell from '../components/AppShell.tsx'
import EmptyState from '../components/EmptyState.tsx'
import NavList from '../components/NavList.tsx'
import Panel from '../components/Panel.tsx'
import RunConsole from '../components/RunConsole.tsx'
import SectionHeading from '../components/SectionHeading.tsx'
import { useRuns } from './useRuns.tsx'
import { RunFailModal } from './RunsModals.tsx'
import RunLaunchModal from './RunLaunchModal.tsx'
import { LAYOUT } from '../theme.ts'
import type { DshProfileInfo, LaunchOptions, RunInfo, RunMode } from '../../../shared/types.ts'

type RunTab = 'launch' | 'processes'

/** A registered dsh, for the launch-target selector. */
interface DshOption {
  id: string
  name: string
}

/** The fixed target a launch-parameter dialog is opened for. */
interface ConfigTarget {
  dshId: string
  dshName: string
  profile: string
}

/** Small section caption inside the process rail. */
function GroupLabel({ children }: { children: ReactNode }): JSX.Element {
  const { token } = theme.useToken()
  return (
    <div style={{ padding: '10px 16px 4px', fontSize: token.fontSizeSM, color: token.colorTextTertiary }}>{children}</div>
  )
}

/** One launch tile: profile name + manifest counts. Only the icons act — the
 * play icon starts it with saved parameters, "…" configures them first. */
function LaunchTile({ name, meta, running, onLaunch, onConfigure }: {
  name: string
  meta: string
  running: boolean
  onLaunch: () => void
  onConfigure: () => void
}): JSX.Element {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const [hovered, setHovered] = useState(false)
  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        minHeight: 64,
        padding: '12px 12px 12px 14px',
        borderRadius: token.borderRadiusLG,
        border: `1px solid ${hovered ? token.colorPrimary : token.colorBorder}`,
        background: running ? token.colorFillQuaternary : token.colorBgContainer,
        opacity: running ? 0.75 : 1,
        transition: 'border-color 0.15s, background 0.15s',
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          color: token.colorText, fontWeight: 600, overflow: 'hidden',
          textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {name}
        </div>
        <div style={{
          fontSize: token.fontSizeSM, marginTop: 2, color: token.colorTextTertiary,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {meta}
        </div>
      </div>
      <Space size={2}>
        {running
          ? <Tag color="success" style={{ marginInlineEnd: 4 }}>{t('run.running')}</Tag>
          : (
            <Tooltip title={t('run.start')}>
              <Button
                type="text"
                shape="circle"
                icon={<PlayCircleOutlined />}
                aria-label={`${t('run.start')} ${name}`}
                onClick={onLaunch}
              />
            </Tooltip>
          )}
        <Tooltip title={t('run.params.title')}>
          <Button
            type="text"
            shape="circle"
            icon={<MoreOutlined />}
            aria-label={`${t('run.params.title')} ${name}`}
            onClick={onConfigure}
          />
        </Tooltip>
      </Space>
    </div>
  )
}

export default function RunsSection(): JSX.Element {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const run = useRuns()

  const [tab, setTab] = useState<RunTab>('launch')
  // Run-page-local dsh selection (defaults to the active dsh but is not bound to it).
  const [dshes, setDshes] = useState<DshOption[]>([])
  const [dshId, setDshId] = useState<string>()
  const [profiles, setProfiles] = useState<DshProfileInfo[]>([])
  const [dshLoading, setDshLoading] = useState(true)
  const [profilesLoading, setProfilesLoading] = useState(false)
  // The profile whose launch-parameter dialog is open (null = closed).
  const [configTarget, setConfigTarget] = useState<ConfigTarget | null>(null)

  useEffect(() => {
    let alive = true
    void window.api.dsh.list().then(result => {
      if (!alive) return
      if (result.ok) {
        setDshes(result.value.dshes.map(d => ({ id: d.id, name: d.name })))
        setDshId(prev => (prev !== undefined && result.value.dshes.some(d => d.id === prev)) ? prev : result.value.dshes[0]?.id)
      }
      setDshLoading(false)
    })
    return () => { alive = false }
  }, [])

  useEffect(() => {
    if (dshId === undefined || dshId === '') { setProfiles([]); return }
    let alive = true
    setProfilesLoading(true)
    void window.api.dsh.profiles(dshId).then(result => {
      if (!alive) return
      setProfiles(result.ok ? result.value : [])
      setProfilesLoading(false)
    })
    return () => { alive = false }
  }, [dshId])

  // Tick once a second so elapsed-time labels stay live while anything runs.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (run.running.length === 0) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [run.running.length])

  const runningKeys = new Set(run.running.map(r => `${r.dshId}::${r.profile}`))

  const formatElapsed = (startedAt: number): string => {
    const total = Math.max(0, Math.floor((now - startedAt) / 1000))
    const h = Math.floor(total / 3600)
    const m = Math.floor((total % 3600) / 60)
    const s = total % 60
    if (h > 0) return t('run.elapsed.hms', { h, m, s })
    if (m > 0) return t('run.elapsed.ms', { m, s })
    return t('run.elapsed.s', { s })
  }

  // Quick launch: saved mode + parameters, stay on the launch tab.
  const quickLaunch = (profile: string): void => {
    if (dshId === undefined) return
    void run.start(profile, undefined, undefined, dshId, false)
  }

  // Configured launch from the dialog: show the process tab so it is visible.
  const handleLaunch = async (mode: RunMode, options: LaunchOptions): Promise<boolean> => {
    if (configTarget === null) return false
    const ok = await run.start(configTarget.profile, mode, options, configTarget.dshId)
    if (ok) { setDshId(configTarget.dshId); setTab('processes') }
    return ok
  }

  const configure = (profile: string): void => {
    if (dshId === undefined) return
    setConfigTarget({ dshId, dshName: dshes.find(d => d.id === dshId)?.name ?? '', profile })
  }

  const confirmStopAll = (): void => {
    Modal.confirm({
      title: t('run.allStopConfirmTitle'),
      content: t('run.allStopConfirm', { count: run.running.length }),
      okText: t('run.allStop'),
      okButtonProps: { danger: true },
      onOk: () => run.stopAll(),
    })
  }

  const statusDot = (item: RunInfo): JSX.Element => (
    <span
      style={{
        width: 8,
        height: 8,
        borderRadius: '50%',
        flex: '0 0 auto',
        background: item.status === 'running' ? token.colorSuccess : token.colorTextQuaternary,
      }}
    />
  )

  const renderTitle = (item: RunInfo): JSX.Element => (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
      {statusDot(item)}
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.profile}</span>
      <Tag style={{ marginInlineStart: 2 }} color={item.mode === 'shell' ? 'purple' : undefined}>
        {item.mode === 'shell' ? t('run.modeShell') : t('run.modeApp')}
      </Tag>
    </span>
  )

  const renderMeta = (item: RunInfo): ReactNode => {
    const state = item.status === 'running'
      ? formatElapsed(item.startedAt)
      : t('run.exitCode', { code: item.code ?? '?' })
    return item.dshName === '' ? state : `${item.dshName} · ${state}`
  }

  const runActions = (item: RunInfo): JSX.Element => (
    item.status === 'running'
      ? <Button size="small" danger onClick={() => void run.stop(item.id)}>{t('run.stop')}</Button>
      : (
        <Space size={4}>
          <Button size="small" onClick={() => void run.restart(item)}>{t('run.restart')}</Button>
          <Button size="small" type="text" onClick={() => run.clearExited(item.id)}>{t('run.clear')}</Button>
        </Space>
      )
  )

  const selected = run.selected
  const selectedRunning = selected?.status === 'running'

  // ── Tab: 启动 ───────────────────────────────────────────────────────────────
  const launchTab = (
    <div style={{ height: '100%', overflowY: 'auto', padding: LAYOUT.pagePaddingLG, background: token.colorBgContainer }}>
      <SectionHeading
        title={t('run.launchTitle')}
        description={t('run.quickLaunchDesc')}
        extra={
          <Space>
            <span style={{ color: token.colorTextSecondary }}>{t('run.selectDsh')}</span>
            <Select
              value={dshId}
              onChange={value => setDshId(String(value))}
              style={{ width: 220 }}
              loading={dshLoading}
              aria-label={t('run.selectDsh')}
              placeholder={t('dsh.selectPlaceholder')}
              options={dshes.map(d => ({ value: d.id, label: d.name }))}
            />
          </Space>
        }
      />
      {profilesLoading ? (
        <Spin />
      ) : profiles.length === 0 ? (
        <EmptyState title={t('run.profilesEmpty')} description={t('run.empty.desc')} />
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 12 }}>
          {profiles.map(info => (
            <LaunchTile
              key={info.name}
              name={info.name}
              meta={t('run.tileMeta', { bundles: info.bundles, deps: info.dependencies })}
              running={runningKeys.has(`${dshId}::${info.name}`)}
              onLaunch={() => quickLaunch(info.name)}
              onConfigure={() => configure(info.name)}
            />
          ))}
        </div>
      )}
    </div>
  )

  // ── Tab: 进程管理 ───────────────────────────────────────────────────────────
  const processesTab = (
    <AppShell
      flush
      contentBg={token.colorBgContainer}
      sider={
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            gap: 8, padding: '10px 12px', borderBottom: `1px solid ${token.colorSplit}`,
          }}>
            <span style={{ color: token.colorTextSecondary, fontSize: token.fontSizeSM }}>
              {t('run.section.active', { count: run.running.length })}
            </span>
            {run.running.length > 0 && (
              <Button size="small" danger onClick={confirmStopAll}>{t('run.allStop')}</Button>
            )}
          </div>
          <div style={{ flex: 1, overflowY: 'auto', paddingBottom: 12 }}>
            <NavList
              items={run.running}
              keyOf={item => item.id}
              selectedKey={run.selectedId ?? undefined}
              onSelect={item => run.select(item.id)}
              renderTitle={renderTitle}
              renderMeta={renderMeta}
              actions={runActions}
              empty={
                <div style={{ padding: '4px 16px', fontSize: token.fontSizeSM, color: token.colorTextTertiary }}>
                  {t('run.empty.active')}
                </div>
              }
            />
            {run.exited.length > 0 && (
              <>
                <GroupLabel>{t('run.section.exited')}</GroupLabel>
                <NavList
                  items={run.exited}
                  keyOf={item => item.id}
                  selectedKey={run.selectedId ?? undefined}
                  onSelect={item => run.select(item.id)}
                  renderTitle={renderTitle}
                  renderMeta={renderMeta}
                  actions={runActions}
                />
              </>
            )}
          </div>
        </div>
      }
    >
      <div style={{ height: '100%', display: 'flex', flexDirection: 'column', gap: token.paddingSM, padding: LAYOUT.pagePaddingLG }}>
        <SectionHeading
          title={selected === undefined ? t('run.processes.title') : selected.profile}
          description={selected === undefined
            ? t('run.processes.desc')
            : (selected.dshName === '' ? '' : `${selected.dshName} · ${selected.mode === 'shell' ? t('run.modeShell') : t('run.modeApp')}`)}
          extra={selected === undefined ? undefined : (
            <Space>
              {selectedRunning
                ? <Button danger onClick={() => void run.stop(selected.id)}>{t('run.stop')}</Button>
                : <Button onClick={() => void run.restart(selected)}>{t('run.restart')}</Button>}
            </Space>
          )}
        />
        {selected === undefined ? (
          <EmptyState title={t('run.processes.empty')} description={t('run.processes.emptyDesc')} />
        ) : selected.mode === 'shell' ? (
          <Panel title={t('run.modeShell')} description={t('run.shellHint')}>
            <pre style={{ margin: 0, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: token.fontSizeSM, color: token.colorTextSecondary, whiteSpace: 'pre-wrap', wordBreak: 'break-word', background: token.colorFillTertiary, padding: token.paddingSM, borderRadius: token.borderRadius }}>
              {selected.command}
            </pre>
          </Panel>
        ) : (
          <div style={{ flex: 1, minHeight: 0 }}>
            <RunConsole
              logs={run.logsOf(selected.id)}
              running={selectedRunning}
              fill
              title={t('run.consoleTitle')}
              onInput={selectedRunning ? (line: string) => { void window.api.run.input(selected.id, line) } : undefined}
              onUrlClick={run.openUrl}
            />
          </div>
        )}
      </div>
    </AppShell>
  )

  return (
    <>
    <Tabs
      className="pm-fill-tabs"
      style={{ background: token.colorBgContainer }}
      activeKey={tab}
      onChange={key => setTab(key as RunTab)}
      items={[
        { key: 'launch', label: <span><RocketOutlined /> {t('run.tab.launch')}</span>, children: launchTab },
        { key: 'processes', label: <span><UnorderedListOutlined /> {t('run.tab.processes')}</span>, children: processesTab },
      ]}
    />

    <RunLaunchModal
      key={configTarget === null ? 'none' : `${configTarget.dshId}::${configTarget.profile}`}
      open={configTarget !== null}
      dshId={configTarget?.dshId ?? ''}
      dshName={configTarget?.dshName ?? ''}
      profile={configTarget?.profile ?? ''}
      onClose={() => setConfigTarget(null)}
      onLaunch={handleLaunch}
    />
    <RunFailModal failInfo={run.failInfo} onClose={run.clearFail} />
    </>
  )
}
