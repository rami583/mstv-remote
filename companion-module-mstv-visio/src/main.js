const {
	InstanceBase,
	InstanceStatus,
	Regex,
	combineRgb,
	runEntrypoint,
} = require('@companion-module/base')

const POLL_INTERVAL_MS = 400
const REQUEST_TIMEOUT_MS = 1500
const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 3100

const COLORS = {
	white: combineRgb(255, 255, 255),
	neutral: combineRgb(68, 68, 68),
	green: combineRgb(0, 180, 80),
	red: combineRgb(212, 48, 31),
}

const defaultStatus = {
	pipEnabled: false,
	globalMuteEnabled: false,
	programGuestIndexes: [],
	programMutedGuestIndexes: [],
	regieGuestIndexes: [],
	regieMutedGuestIndexes: [],
	connectedGuestCount: 0,
}

class MstvVisioInstance extends InstanceBase {
	constructor(internal) {
		super(internal)
		this.config = {}
		this.status = defaultStatus
		this.pollTimer = undefined
	}

	async init(config) {
		this.config = this.normalizeConfig(config)
		this.updateActions()
		this.updateFeedbacks()
		this.updatePresets()
		this.startPolling()
		await this.pollStatus()
	}

	async destroy() {
		this.stopPolling()
	}

	async configUpdated(config) {
		this.config = this.normalizeConfig(config)
		this.startPolling()
		await this.pollStatus()
	}

	getConfigFields() {
		return [
			{
				type: 'textinput',
				id: 'host',
				label: 'MSTV Visio Host',
				width: 8,
				default: DEFAULT_HOST,
			},
			{
				type: 'textinput',
				id: 'port',
				label: 'Port',
				width: 4,
				default: String(DEFAULT_PORT),
				regex: Regex.PORT,
			},
		]
	}

	normalizeConfig(config) {
		return {
			host: String(config?.host || DEFAULT_HOST).trim() || DEFAULT_HOST,
			port: Number(config?.port || DEFAULT_PORT) || DEFAULT_PORT,
		}
	}

	getBaseUrl() {
		const rawHost = this.config.host || DEFAULT_HOST
		const host = rawHost.replace(/^https?:\/\//i, '').replace(/\/+$/, '')
		return `http://${host}:${this.config.port || DEFAULT_PORT}`
	}

	async request(path, options = {}) {
		const controller = new AbortController()
		const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

		try {
			const response = await fetch(`${this.getBaseUrl()}${path}`, {
				...options,
				headers: {
					'Content-Type': 'application/json',
					...(options.headers || {}),
				},
				signal: controller.signal,
			})

			if (!response.ok) {
				throw new Error(`HTTP ${response.status}`)
			}

			return await response.json()
		} finally {
			clearTimeout(timeout)
		}
	}

	async sendAction(payload) {
		await this.request('/api/companion/action', {
			method: 'POST',
			body: JSON.stringify(payload),
		})
		await this.pollStatus()
	}

	startPolling() {
		this.stopPolling()
		this.pollTimer = setInterval(() => {
			void this.pollStatus()
		}, POLL_INTERVAL_MS)
	}

	stopPolling() {
		if (this.pollTimer) {
			clearInterval(this.pollTimer)
			this.pollTimer = undefined
		}
	}

	async pollStatus() {
		try {
			const status = await this.request('/api/companion/status')
			this.status = {
				...defaultStatus,
				...status,
			}
			this.updateStatus(InstanceStatus.Ok)
			this.checkFeedbacks('guest_active', 'pip_active', 'mute_active')
		} catch (error) {
			this.updateStatus(
				InstanceStatus.ConnectionFailure,
				error instanceof Error ? error.message : 'Unable to reach MSTV Visio'
			)
		}
	}

	updateActions() {
		const actions = {}

		for (let guestIndex = 1; guestIndex <= 9; guestIndex += 1) {
			actions[`select_guest_${guestIndex}`] = {
				name: `Select Guest ${guestIndex}`,
				options: [],
				callback: async () => {
					await this.sendAction({
						action: 'selectGuest',
						guestIndex,
					})
				},
			}
		}

		actions.toggle_pip = {
			name: 'Toggle PIP',
			options: [],
			callback: async () => {
				await this.sendAction({
					action: 'togglePip',
				})
			},
		}

		actions.toggle_mute_all = {
			name: 'Toggle Mute All',
			options: [],
			callback: async () => {
				await this.sendAction({
					action: 'toggleMuteAllProgramGuests',
				})
			},
		}

		this.setActionDefinitions(actions)
	}

	updateFeedbacks() {
		this.setFeedbackDefinitions({
			guest_active: {
				name: 'Guest button active',
				type: 'boolean',
				label: 'Guest is in Program',
				defaultStyle: {
					bgcolor: COLORS.green,
					color: COLORS.white,
				},
				options: [
					{
						id: 'guestIndex',
						type: 'number',
						label: 'Guest Index',
						default: 1,
						min: 1,
						max: 9,
					},
				],
				callback: (feedback) => {
					return this.status.programGuestIndexes.includes(Number(feedback.options.guestIndex))
				},
			},
			pip_active: {
				name: 'PIP active',
				type: 'boolean',
				label: 'PIP is active',
				defaultStyle: {
					bgcolor: COLORS.green,
					color: COLORS.white,
				},
				options: [],
				callback: () => Boolean(this.status.pipEnabled),
			},
			mute_active: {
				name: 'Mute active',
				type: 'boolean',
				label: 'Global mute is active',
				defaultStyle: {
					bgcolor: COLORS.red,
					color: COLORS.white,
				},
				options: [],
				callback: () => Boolean(this.status.globalMuteEnabled),
			},
		})
	}

	updatePresets() {
		const presets = {}
		const structureDefinitions = []

		for (let guestIndex = 1; guestIndex <= 9; guestIndex += 1) {
			const presetId = `guest_${guestIndex}`
			structureDefinitions.push(presetId)
			presets[presetId] = {
				type: 'simple',
				name: `Guest ${guestIndex}`,
				style: {
					text: `Guest ${guestIndex}`,
					size: '18',
					color: COLORS.white,
					bgcolor: COLORS.neutral,
				},
				steps: [
					{
						down: [
							{
								actionId: `select_guest_${guestIndex}`,
								options: {},
							},
						],
						up: [],
					},
				],
				feedbacks: [
					{
						feedbackId: 'guest_active',
						options: {
							guestIndex,
						},
						style: {
							bgcolor: COLORS.green,
							color: COLORS.white,
						},
					},
				],
			}
		}

		presets.pip = {
			type: 'simple',
			name: 'PIP',
			style: {
				text: 'PIP',
				size: '24',
				color: COLORS.white,
				bgcolor: COLORS.neutral,
			},
			steps: [
				{
					down: [
						{
							actionId: 'toggle_pip',
							options: {},
						},
					],
					up: [],
				},
			],
			feedbacks: [
				{
					feedbackId: 'pip_active',
					options: {},
					style: {
						bgcolor: COLORS.green,
						color: COLORS.white,
					},
				},
			],
		}

		presets.mute = {
			type: 'simple',
			name: 'MUTE',
			style: {
				text: 'MUTE',
				size: '24',
				color: COLORS.white,
				bgcolor: COLORS.neutral,
			},
			steps: [
				{
					down: [
						{
							actionId: 'toggle_mute_all',
							options: {},
						},
					],
					up: [],
				},
			],
			feedbacks: [
				{
					feedbackId: 'mute_active',
					options: {},
					style: {
						bgcolor: COLORS.red,
						color: COLORS.white,
					},
				},
			],
		}

		this.setPresetDefinitions(
			[
				{
					id: 'section-main',
					name: 'MSTV Visio',
					definitions: [...structureDefinitions, 'pip', 'mute'],
				},
			],
			presets
		)
	}
}

runEntrypoint(MstvVisioInstance, [])
