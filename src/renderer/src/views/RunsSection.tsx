/** Run page — two tabs:
 *   - 启动 (Launch): the rail lists the registered dsh (one card each) and the
 *     content is the selected dsh's profiles as a tile grid. A tile's play icon
 *     launches with saved parameters AND moves to 进程管理, where the new console
 *     is; its "…" icon opens the launch dialog to configure them first.
 *   - 进程管理 (Processes): a two-pane view (process rail + console) for every
 *     live run, plus runs that ended this session.
 *
 * Concurrency model (see docs/specs/launch.md §5): different (dsh, profile)
 * pairs run in parallel; the same pair is limited to one live process. */

import { useEffect, useState, type ComponentType, type ReactNode } from 'react'
import { Button, Modal, Space, Spin, Tabs, Tag, Tooltip, theme } from 'antd'
import {
  CloseOutlined, MoreOutlined, PlayCircleOutlined, PoweroffOutlined, ReloadOutlined, RocketOutlined,
  UnorderedListOutlined,
} from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import AppShell from '../components/AppShell.tsx'
import EmptyState from '../components/EmptyState.tsx'
import NavList from '../components/NavList.tsx'
import Panel from '../components/Panel.tsx'
import RunConsole from '../components/RunConsole.tsx'
import SectionHeading from '../components/SectionHeading.tsx'
import { RUN_DSH_KEY, readDshSelection, saveDshSelection } from '../lib/dshSelection.ts'
import { runCardActions, runCardMeta, runDotKind, type RunCardAction, type RunDotKind } from '../lib/runCard.ts'
import { useRuns } from './useRuns.tsx'
import { RunConflictModal, RunFailModal } from './RunsModals.tsx'
import RunLaunchModal from './RunLaunchModal.tsx'
import { LAYOUT } from '../theme.ts'
import type { DshEntry, DshProfileInfo, LaunchOptions, RunInfo, RunMode } from '../../../shared/types.ts'

type RunTab = 'launch' | 'processes'

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

/** A rail card's actions as icons: the 280px rail has no room for the labels,
 * and both are one click from the labelled buttons the console header shows for
 * the selected run. Every button keeps its label in the tooltip + aria-label.
 * `stop` is the power glyph rather than a barred circle — that one reads as
 * "not allowed", which is not what ending this process means. */
const RUN_ACTION_ICON: Record<RunCardAction, ComponentType> = {
  stop: PoweroffOutlined, restart: ReloadOutlined, clear: CloseOutlined,
}
/** Literal keys (not `string`) so `t` stays key-checked. */
const RUN_ACTION_LABEL: Record<RunCardAction, 'run.stop' | 'run.restart' | 'run.clear'> = {
  stop: 'run.stop', restart: 'run.restart', clear: 'run.clear',
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
  // Run-page-local dsh selection: remembered across restarts and tab switches,
  // falling back to the first registered dsh when the stored one is gone. Not
  // bound to any global "active dsh".
  const [dshes, setDshes] = useState<DshEntry[]>([])
  const [dshId, setDshId] = useState<string | undefined>(
    () => readDshSelection(RUN_DSH_KEY) || undefined,
  )
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
        setDshes(result.value.dshes)
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
  // Which dsh have a live run — marked on their rail card, matching the DSH page.
  const runningDshIds = new Set(run.running.map(r => r.dshId))

  const formatElapsed = (startedAt: number): string => {
    const total = Math.max(0, Math.floor((now - startedAt) / 1000))
    const h = Math.floor(total / 3600)
    const m = Math.floor((total % 3600) / 60)
    const s = total % 60
    if (h > 0) return t('run.elapsed.hms', { h, m, s })
    if (m > 0) return t('run.elapsed.ms', { m, s })
    return t('run.elapsed.s', { s })
  }

  /** Switch the launch target, remembering it for the next visit. */
  const selectDsh = (id: string): void => {
    setDshId(id)
    saveDshSelection(RUN_DSH_KEY, id)
  }

  // Quick launch: saved mode + parameters, then straight to the console. A
  // refused start stays here — its toast (or the conflict modal) is the answer.
  const quickLaunch = (profile: string): void => {
    if (dshId === undefined) return
    void run.start(profile, undefined, undefined, dshId).then(ok => { if (ok) setTab('processes') })
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

  /** The status dot: live (green), ended abnormally (red), ended (grey — a
   * crash and a clean exit are not the same answer). */
  const statusDot = (item: RunInfo): JSX.Element => {
    const kind: RunDotKind = runDotKind(item)
    return (
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          flex: '0 0 auto',
          background: kind === 'running'
            ? token.colorSuccess
            : (kind === 'failed' ? token.colorError : token.colorTextQuaternary),
        }}
      />
    )
  }

  // The title row carries ONLY the dot + the profile name: the mode used to sit
  // here as a tag and squeezed the one thing the card exists to say.
  const renderTitle = (item: RunInfo): JSX.Element => (
    <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
      {statusDot(item)}
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.profile}</span>
    </span>
  )

  const runState = (item: RunInfo): string =>
    item.status === 'running' ? formatElapsed(item.startedAt) : t('run.exitCode', { code: item.code ?? '?' })

  /** One meta line for everything else: state · mode · dsh. */
  const renderMeta = (item: RunInfo): ReactNode => {
    const meta = runCardMeta(item, runState(item), t(item.mode === 'shell' ? 'run.modeShell' : 'run.modeApp'))
    return (
      <span
        title={meta}
        style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
      >
        {meta}
      </span>
    )
  }

  const runActions = (item: RunInfo): JSX.Element => (
    <Space size={0}>
      {runCardActions(item).map(action => {
        const label = t(RUN_ACTION_LABEL[action])
        const Icon = RUN_ACTION_ICON[action]
        return (
          <Tooltip key={action} title={label}>
            <Button
              size="small"
              type="text"
              danger={action === 'stop'}
              icon={<Icon />}
              aria-label={`${label} ${item.profile}`}
              onClick={() => {
                if (action === 'stop') void run.stop(item.id)
                else if (action === 'restart') void run.restart(item)
                else run.clearExited(item.id)
              }}
            />
          </Tooltip>
        )
      })}
    </Space>
  )

  const selected = run.selected
  const selectedRunning = selected?.status === 'running'

  // ── Tab: 启动 ───────────────────────────────────────────────────────────────
  const launchTab = (
    <AppShell
      flush
      contentBg={token.colorBgContainer}
      sider={
        // The rail states its scope and lists the installs as cards: the launch
        // target stays visible (and switchable) without scrolling the tile grid,
        // and a card has room for what the dropdown could not say — its version,
        // and whether anything of it is already running.
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
          <div style={{
            display: 'flex', alignItems: 'center',
            padding: '10px 12px', borderBottom: `1px solid ${token.colorSplit}`,
          }}>
            <span style={{ color: token.colorTextSecondary, fontSize: token.fontSizeSM }}>
              {t('run.section.dsh', { count: dshes.length })}
            </span>
          </div>
          <div style={{ flex: 1, overflowY: 'auto', paddingBottom: 12 }}>
            <NavList
              items={dshes}
              keyOf={d => d.id}
              selectedKey={dshId}
              onSelect={d => selectDsh(d.id)}
              renderTitle={d => d.name}
              renderMeta={d => (
                <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {d.version === '' ? t('common.unknown') : d.version}
                  </span>
                  {runningDshIds.has(d.id) && (
                    <Tag color="success" style={{ marginInlineEnd: 0 }}>{t('run.running')}</Tag>
                  )}
                </span>
              )}
              loading={dshLoading}
              empty={<EmptyState title={t('run.empty.dsh')} description={t('run.empty.dshDesc')} />}
            />
          </div>
        </div>
      }
    >
      <div style={{ height: '100%', overflowY: 'auto', padding: LAYOUT.pagePaddingLG }}>
        <SectionHeading title={t('run.launchTitle')} description={t('run.quickLaunchDesc')} />
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
    </AppShell>
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
    <RunConflictModal info={run.conflictInfo} onClose={run.clearConflict} />
    </>
  )
}
