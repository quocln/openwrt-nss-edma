'use strict';
'require view';
'require form';
'require fs';
'require uci';
'require ui';
'require poll';
'require dom';

// The page for /usr/sbin/vpn-failover: which VPN the network uses, the list of VPNs to choose
// from, and the settings (the uci config vpn-failover). Connecting, adding and deleting act at
// once; the settings have their own Save button. The page decides nothing about routing itself.

var TOOL = '/usr/sbin/vpn-failover';
// the one path the ACL lets this page write; "vpn-failover add" deletes it again
var IMPORT_FILE = '/tmp/vpn-failover-import.conf';

// one colour per state of the VPN in use, for the banner, the card and its badge
var COLOUR = {
	up: '#2e7d32',
	connecting: '#1565c0',
	down: '#ef6c00',
	stopped: '#c62828',
	error: '#c62828',
	off: '#757575'
};

var CSS = [
	'.vpnf-banner { padding:1em 1.2em; border-radius:.6em; margin-bottom:1.5em;',
	'  border:1px solid rgba(128,128,128,.35); border-left:.5em solid }',
	'.vpnf-title { font-size:1.35em; font-weight:bold; line-height:1.3 }',
	'.vpnf-sub { opacity:.8; font-size:.95em }',
	'.vpnf-list { display:flex; flex-direction:column; gap:.6em; margin-bottom:.8em }',
	'.vpnf-busy button { pointer-events:none; opacity:.5 }',
	'.vpnf-card { display:flex; flex-wrap:wrap; align-items:center; gap:.6em 1em; padding:.8em 1.1em;',
	'  border-radius:.6em; border:1px solid rgba(128,128,128,.35) }',
	'.vpnf-card.vpnf-selected { border-width:2px }',
	'.vpnf-grow { flex:1; min-width:12em }',
	'.vpnf-name { font-weight:bold; font-size:1.08em }',
	'.vpnf-badge { display:inline-block; margin-left:.6em; padding:.1em .7em; border-radius:1em;',
	'  color:#fff; font-size:.72em; font-weight:bold; letter-spacing:.03em; vertical-align:middle }',
	'.vpnf-note { margin:0 0 1em; padding:.6em 1em; border-radius:.5em; background:rgba(128,128,128,.15) }',
	'.vpnf-add { padding:1em 1.1em; border-radius:.6em; border:1px dashed rgba(128,128,128,.6); margin-bottom:1.5em }',
	'.vpnf-add label { display:block; font-weight:bold; margin:1em 0 .3em }',
	'.vpnf-add label:first-child { margin-top:0 }',
	'.vpnf-add input[type=text], .vpnf-add textarea { width:100%; max-width:36em; box-sizing:border-box }',
	'.vpnf-add textarea { max-width:none; font-family:monospace }',
	'.vpnf-add details { margin-top:1em }',
	'.vpnf-add summary { cursor:pointer }',
	'.vpnf-actions { margin-top:1em; display:flex; gap:.6em }',
	'.vpnf-save { margin:-.5em 0 1.5em; display:flex; flex-wrap:wrap; align-items:center; gap:.5em 1em }'
].join('\n');

function getStatus() {
	return fs.exec(TOOL, [ 'status' ]).then(function(res) {
		if (res.code !== 0)
			throw new Error(res.stderr || 'vpn-failover status failed');
		return JSON.parse(res.stdout);
	}).catch(function(e) {
		return { error: e.message, profiles: [] };
	});
}

function runTool(args) {
	return fs.exec(TOOL, args).then(function(res) {
		if (res.code !== 0)
			throw new Error((res.stderr || res.stdout || '').trim().replace(/^error: /, ''));
		return (res.stdout || '').trim();
	});
}

function nameOf(st, id) {
	var found = (st.profiles || []).filter(function(p) { return p.id === id; })[0];
	return found ? found.name : id;
}

// "45 s", "17 min", "2 h 5 min", "3 days"
function duration(seconds) {
	var m, h;

	seconds = Math.max(0, Math.round(seconds));
	if (seconds < 60)
		return _('%d s').format(seconds);
	m = Math.floor(seconds / 60);
	if (m < 60)
		return _('%d min').format(m);
	h = Math.floor(m / 60);
	if (h < 48)
		return (m % 60) ? _('%d h %d min').format(h, m % 60) : _('%d h').format(h);
	return _('%d days').format(Math.floor(h / 24));
}

// what the VPN in use is doing: off, connecting, up, down, stopped (its watchdog), error
function phaseOf(st) {
	if (st.error)
		return 'error';
	if (!st.active)
		return 'off';
	// the watchdog restarts when the VPN changes: for those seconds it is connecting, not broken
	if (!st.running)
		return st.justChanged ? 'connecting' : 'stopped';
	if (st.state === 'up' || st.state === 'down')
		return st.state;
	return 'connecting';
}

// Names, addresses and error texts come from the router and from files the user gave it. E()
// only builds text nodes for array members, so the brackets around them are load-bearing.
function renderBanner(st) {
	var phase = phaseOf(st), name = nameOf(st, st.active), title, sub;

	switch (phase) {
	case 'error':
		title = _('The VPN state could not be read');
		sub = st.error;
		break;
	case 'off':
		title = _('VPN is off');
		sub = _('All devices use the normal internet connection.');
		break;
	case 'stopped':
		title = _('%s is selected, but its monitor is not running').format(name);
		sub = _('All devices use the normal internet connection. Press Connect on it again; if this stays, restart the router.');
		break;
	case 'up':
		title = _('Connected to %s').format(name);
		sub = (st.dns
			? _('All devices go through this VPN, and the router looks names up at its DNS server %s.').format(st.dns)
			: _('All devices go through this VPN. The router looks names up at its normal DNS servers.'))
			+ ' ' + _('Connected for %s.').format(duration(st.now - st.since));
		break;
	case 'down':
		title = _('%s is not responding').format(name);
		sub = _('All devices have been on the normal internet connection for %s. The router keeps checking and goes back to this VPN by itself. You can also connect another one.').format(duration(st.now - st.since));
		break;
	default:
		title = _('Connecting to %s…').format(name);
		sub = _('Devices keep using the normal internet connection until the VPN responds, usually a few seconds.');
	}

	return E('div', { 'class': 'vpnf-banner', 'style': 'border-left-color:' + COLOUR[phase] }, [
		E('div', { 'class': 'vpnf-title' }, [ title ]),
		E('div', { 'class': 'vpnf-sub' }, [ sub ])
	]);
}

return view.extend({
	load: function() {
		return Promise.all([
			getStatus(),
			uci.load('dhcp')
		]);
	},

	// The settings are saved with their own button next to them: the footer with LuCI's three
	// buttons would sit under a page whose other actions all act at once.
	addFooter: function() {
		return E('div');
	},

	note: function(text, isError) {
		dom.content(this.noteBox, text ? E('div', {
			'class': 'vpnf-note',
			'style': isError ? 'border-left:.4em solid ' + COLOUR.error : null
		}, [ text ]) : '');
	},

	// run one action of the tool, then show the new state. What the tool says goes into the note
	// under the list, the reason of a failure included.
	act: function(run, failed) {
		this.busy = true;
		this.listBox.classList.add('vpnf-busy');
		this.note('');

		return run().then(L.bind(function(said) {
			this.note(said);
		}, this), L.bind(function(e) {
			this.note(failed.format(e.message), true);
		}, this)).then(L.bind(function() {
			this.busy = false;
			this.listBox.classList.remove('vpnf-busy');
			this.changedAt = Date.now();
			return this.refresh();
		}, this));
	},

	refresh: function() {
		return getStatus().then(L.bind(this.paint, this));
	},

	paint: function(st) {
		st.justChanged = (Date.now() - (this.changedAt || 0)) < 15000;
		this.count = (st.profiles || []).length;
		dom.content(this.bannerBox, renderBanner(st));
		dom.content(this.listBox, this.renderList(st));
	},

	handleUse: function(id) {
		return this.act(function() {
			// the banner already says "VPN is off" or "Connecting to ...": no note on top of it
			return runTool([ 'use', id ]).then(function() { return ''; });
		}, _('That did not work: %s'));
	},

	handleSaveSettings: function(ev) {
		// save, then apply at once, as "Save & Apply" of LuCI's own footer does
		return this.handleSaveApply(ev, '0');
	},

	handleDelete: function(id) {
		ui.hideModal();
		return this.act(function() { return runTool([ 'delete', id ]); }, _('The VPN was not deleted: %s'));
	},

	askDelete: function(profile, selected) {
		ui.showModal(_('Delete %s?').format(profile.name), [
			E('p', {}, [ _('Its settings and key are removed from the router. To use it again later, add its file again.') ]),
			selected ? E('p', {}, [ E('strong', {}, [ _('This is the VPN in use: all devices switch to the normal internet connection.') ]) ]) : '',
			E('div', { 'class': 'right' }, [
				E('button', { 'class': 'btn', 'click': ui.hideModal }, [ _('Cancel') ]),
				' ',
				E('button', {
					'class': 'btn cbi-button-negative',
					'click': ui.createHandlerFn(this, 'handleDelete', profile.id)
				}, [ _('Delete') ])
			])
		]);
	},

	renderCard: function(o) {
		var right = [], style = null, badge = '';

		if (o.selected) {
			style = 'border-color:%s; background:%s1f'.format(COLOUR[o.phase], COLOUR[o.phase]);
			badge = E('span', { 'class': 'vpnf-badge', 'style': 'background:' + COLOUR[o.phase] }, [ o.badge ]);
		}
		else {
			right.push(E('button', {
				'class': 'btn cbi-button-action',
				'click': ui.createHandlerFn(this, 'handleUse', o.id)
			}, [ o.button ]));
		}

		if (o.profile)
			right.push(E('button', {
				'class': 'btn cbi-button-negative',
				'title': _('Remove this VPN from the router'),
				'click': ui.createHandlerFn(this, 'askDelete', o.profile, o.selected)
			}, [ _('Delete') ]));

		return E('div', { 'class': 'vpnf-card' + (o.selected ? ' vpnf-selected' : ''), 'style': style }, [
			E('div', { 'class': 'vpnf-grow' }, [
				E('div', { 'class': 'vpnf-name' }, [ o.name, badge ]),
				E('div', { 'class': 'vpnf-sub' }, [ o.detail ])
			])
		].concat(right));
	},

	renderList: function(st) {
		var phase = phaseOf(st);
		var badges = {
			up: _('CONNECTED'),
			connecting: _('CONNECTING…'),
			down: _('NOT RESPONDING'),
			stopped: _('SELECTED')
		};
		var cards = [];

		(st.profiles || []).forEach(L.bind(function(p) {
			var selected = (st.active === p.id);
			var detail = _('Server %s').format(p.endpoint);

			if (selected && phase === 'down')
				detail += ' · ' + (st.handshake
					? _('last heard from %s ago').format(duration(st.now - st.handshake))
					: _('never heard from'));

			cards.push(this.renderCard({
				id: p.id, name: p.name, detail: detail, profile: p,
				selected: selected, phase: phase, badge: badges[phase], button: _('Connect')
			}));
		}, this));

		// nothing to choose between yet: say how to start, and leave the "No VPN" choice out
		if (!cards.length)
			return E('p', {}, [ _('No VPN has been added yet. Choose the WireGuard file of your VPN provider below.') ]);

		cards.push(this.renderCard({
			id: 'none', name: _('No VPN'), detail: _('All devices use the normal internet connection.'),
			selected: !st.active, phase: 'off', badge: _('SELECTED'), button: _('Turn VPN off')
		}));

		return E('div', { 'class': 'vpnf-list' }, cards);
	},

	handleAdd: function(nameInput, fileInput, textarea, panel) {
		var name = nameInput.value.replace(/\s+/g, ' ').trim();
		var first = !this.count;
		var read;

		if (textarea.value.trim())
			read = Promise.resolve(textarea.value);
		else if (fileInput.files[0])
			read = fileInput.files[0].text();
		else {
			this.note(_('Choose the WireGuard file of the VPN first (or paste its text).'), true);
			return;
		}

		return this.act(function() {
			return read.then(function(text) {
				// 384 is mode 0600: the file holds the private key until the tool deletes it
				return fs.write(IMPORT_FILE, (name ? '# Name = ' + name + '\n' : '') + text.trim() + '\n', 384);
			}).then(function() {
				return runTool([ 'add', IMPORT_FILE ]);
			}).then(function(said) {
				nameInput.value = '';
				fileInput.value = '';
				textarea.value = '';
				panel.style.display = 'none';
				// the tool's first line is "Added <name>."
				return said.split('\n')[0] + ' ' + (first
					? _('It is the first one, so it is being connected now.')
					: _('Press Connect on it to switch to it.'));
			});
		}, _('The VPN was not added. %s'));
	},

	renderAdd: function(open) {
		var nameInput = E('input', { 'type': 'text', 'class': 'cbi-input-text', 'maxlength': 30, 'placeholder': _('for example: Singapore') });
		var fileInput = E('input', {
			'type': 'file',
			'accept': '.conf,text/plain',
			'change': function() {
				// show the name the VPN will get, taken from the file's name, to keep or change
				if (fileInput.files[0] && !nameInput.value)
					nameInput.value = fileInput.files[0].name.replace(/\.[^.]*$/, '').substring(0, 30);
			}
		});
		var textarea = E('textarea', {
			'class': 'cbi-input-textarea',
			'rows': 9,
			'spellcheck': 'false',
			'placeholder': '[Interface]\nPrivateKey = ...\nAddress = ...\nDNS = ...\n\n[Peer]\nPublicKey = ...\nAllowedIPs = 0.0.0.0/0\nEndpoint = vpn.example.com:51820'
		});
		var panel = E('div', { 'class': 'vpnf-add', 'style': open ? null : 'display:none' });

		dom.content(panel, [
			E('label', {}, [ _('WireGuard configuration file') ]),
			E('div', { 'class': 'vpnf-sub', 'style': 'margin-bottom:.5em' }, [
				_('A .conf file that you download from your VPN provider (look for “WireGuard” or “manual setup” in your account there).')
			]),
			fileInput,
			E('label', {}, [ _('Name shown in the list') ]),
			nameInput,
			E('details', {}, [
				E('summary', {}, [ _('No file? Paste the configuration text instead') ]),
				textarea
			]),
			E('div', { 'class': 'vpnf-actions' }, [
				E('button', {
					'class': 'btn cbi-button-action',
					'click': ui.createHandlerFn(this, 'handleAdd', nameInput, fileInput, textarea, panel)
				}, [ _('Add this VPN') ]),
				E('button', { 'class': 'btn', 'click': function() { panel.style.display = 'none'; } }, [ _('Cancel') ])
			])
		]);

		return [
			E('p', {}, [
				E('button', {
					'class': 'btn cbi-button-add',
					'click': function() { panel.style.display = ''; }
				}, [ _('+ Add a VPN') ])
			]),
			panel
		];
	},

	render: function(data) {
		var st = data[0], m, s, o;

		m = new form.Map('vpn-failover');

		s = m.section(form.NamedSection, 'main', 'failover', _('Settings'));
		s.addremove = false;
		s.tab('devices', _('Devices that skip the VPN'),
			_('Devices listed here always use the normal internet connection, also while a VPN is connected. Useful for a device that does not work through a VPN.'));
		s.tab('dns', _('DNS'),
			_('DNS turns names such as example.com into addresses. Devices ask the router, and the router asks a DNS server.'));
		s.tab('advanced', _('Advanced'),
			_('How the router decides that the VPN has stopped working. The values it comes with suit most connections.'));

		o = s.taboption('devices', form.DynamicList, 'direct_ip', _('Devices'),
			_('The list offers the devices that have a fixed address. To give a device one, add it under <a href="%s">Network → DHCP and DNS → Static Leases</a>. You can also type an address such as 192.168.7.50.').format(L.url('admin/network/dhcp')));
		o.datatype = 'ip4addr("nomask")';
		o.placeholder = _('choose a device or type its address');
		uci.sections('dhcp', 'host', function(host) {
			L.toArray(host.ip).forEach(function(ip) {
				if (ip && ip.indexOf(':') < 0)
					o.value(ip, '%s (%s)'.format(host.name || L.toArray(host.mac).join(' ') || '?', ip));
			});
		});

		o = s.taboption('dns', form.Flag, 'vpn_dns', _('Use the DNS server of the VPN'),
			_('On: while a VPN is connected, the router asks the DNS server named in that VPN’s file, through the VPN. Off: the router keeps asking its normal DNS servers, so your internet provider can still see which names are looked up. While no VPN is connected the router always uses its normal DNS servers.'));
		o.default = '1';
		o.rmempty = false;

		o = s.taboption('advanced', form.DynamicList, 'probe_target', _('Test addresses'),
			_('Internet addresses the router pings through the VPN. The VPN counts as working while at least one of them replies.'));
		o.datatype = 'ip4addr("nomask")';
		o.placeholder = '1.1.1.1';

		o = s.taboption('advanced', form.Value, 'interval', _('Test every (seconds)'));
		o.datatype = 'range(2,300)';
		o.placeholder = '10';

		o = s.taboption('advanced', form.Value, 'down_after', _('Leave the VPN after (failed tests in a row)'),
			_('With 3 failed tests, 10 seconds apart, devices are on the normal connection 30 to 40 seconds after the VPN stops working.'));
		o.datatype = 'range(1,20)';
		o.placeholder = '3';

		o = s.taboption('advanced', form.Value, 'up_after', _('Return to the VPN after (good tests in a row)'));
		o.datatype = 'range(1,20)';
		o.placeholder = '2';

		this.bannerBox = E('div');
		this.listBox = E('div');
		this.noteBox = E('div');
		this.paint(st);

		poll.add(L.bind(function() {
			// not in the middle of an action: its button would lose its spinner
			if (!this.busy)
				return this.refresh();
		}, this), 5);

		return m.render().then(L.bind(function(mapEl) {
			return E('div', {}, [
				E('style', {}, [ CSS ]),
				E('h2', {}, [ _('House VPN') ]),
				E('div', { 'class': 'cbi-map-descr' }, [
					_('Choose one VPN for the whole network. If it stops working, all devices use the normal internet connection by themselves, and go back to the VPN when it works again.')
				]),
				this.bannerBox,
				E('h3', {}, [ _('Your VPNs') ]),
				this.listBox,
				this.noteBox
			].concat(this.renderAdd(!this.count), [
				mapEl,
				E('div', { 'class': 'vpnf-save' }, [
					E('button', {
						'class': 'btn cbi-button-save',
						'click': ui.createHandlerFn(this, 'handleSaveSettings')
					}, [ _('Save settings') ]),
					E('span', { 'class': 'vpnf-sub' }, [
						_('Saving reconnects the VPN: for a few seconds devices use the normal internet connection.')
					])
				])
			]));
		}, this));
	}
});
