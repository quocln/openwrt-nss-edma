'use strict';
'require view';
'require form';
'require fs';
'require uci';
'require ui';
'require poll';
'require dom';

// The page for /usr/sbin/vpn-failover: which VPN the house uses, the list of VPNs to choose
// from, and the settings (the uci config vpn-failover). Choosing, adding and deleting a VPN act
// at once; the settings go through Save & Apply. The page decides nothing about routing itself.

var TOOL = '/usr/sbin/vpn-failover';
// the one path the ACL lets this page write; "vpn-failover add" deletes it again
var IMPORT_FILE = '/tmp/vpn-failover-import.conf';

var CSS = [
	'.vpnf-banner { display:flex; align-items:center; gap:1em; padding:1em 1.2em; border-radius:.6em;',
	'  border:1px solid rgba(128,128,128,.35); border-left-width:.5em; margin-bottom:1.5em }',
	'.vpnf-banner .vpnf-title { font-size:1.35em; font-weight:bold; line-height:1.3 }',
	'.vpnf-sub { opacity:.75; font-size:.92em }',
	'.vpnf-list { display:flex; flex-direction:column; gap:.6em; margin-bottom:1em }',
	'.vpnf-card { display:flex; align-items:center; gap:1em; padding:.8em 1.1em; border-radius:.6em;',
	'  border:1px solid rgba(128,128,128,.35) }',
	'.vpnf-card.vpnf-active { border-color:#2e7d32; background:rgba(46,125,50,.12) }',
	'.vpnf-dot { width:1.1em; height:1.1em; border-radius:50%; border:2px solid rgba(128,128,128,.7); flex:none }',
	'.vpnf-active .vpnf-dot { border-color:#2e7d32; background:#2e7d32; box-shadow:inset 0 0 0 .2em rgba(255,255,255,.9) }',
	'.vpnf-grow { flex:1; min-width:0 }',
	'.vpnf-name { font-weight:bold; font-size:1.08em }',
	'.vpnf-badge { display:inline-block; margin-left:.6em; padding:.1em .6em; border-radius:1em;',
	'  background:#2e7d32; color:#fff; font-size:.75em; font-weight:bold; vertical-align:middle }',
	'.vpnf-add { padding:1em 1.1em; border-radius:.6em; border:1px dashed rgba(128,128,128,.6); margin-bottom:1.5em }',
	'.vpnf-add label { display:block; font-weight:bold; margin:.8em 0 .3em }',
	'.vpnf-add label:first-child { margin-top:0 }',
	'.vpnf-add input[type=text], .vpnf-add textarea { width:100%; max-width:36em; box-sizing:border-box }',
	'.vpnf-add textarea { max-width:none; font-family:monospace }',
	'.vpnf-add details { margin-top:.8em }',
	'.vpnf-actions { margin-top:1em; display:flex; gap:.6em }'
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
			throw new Error((res.stderr || res.stdout || '').trim());
		return (res.stdout || '').trim();
	});
}

function nameOf(st, id) {
	var found = (st.profiles || []).filter(function(p) { return p.id === id; })[0];
	return found ? found.name : id;
}

function age(st, since) {
	return '%t'.format(Math.max(0, st.now - since));
}

// Names and endpoints come from files the user gave the router. E() only builds text nodes
// for array members, so the brackets around them are load-bearing.
function renderBanner(st) {
	var colour, title, sub;

	if (st.error) {
		colour = '#c62828';
		title = _('The state could not be read');
		sub = st.error;
	}
	else if (!st.active) {
		colour = '#757575';
		title = _('VPN is off');
		sub = _('The house uses the ISP connection.');
	}
	else if (!st.running && !st.justChanged) {
		colour = '#c62828';
		title = _('%s: the watchdog is not running').format(nameOf(st, st.active));
		sub = _('The house uses the ISP connection.');
	}
	else if (st.running && st.state === 'up') {
		colour = '#2e7d32';
		title = _('Through %s').format(nameOf(st, st.active));
		sub = _('The house goes through the VPN, for %s now.').format(age(st, st.since));
	}
	else if (st.running && st.state === 'down') {
		colour = '#f9a825';
		title = _('%s does not answer').format(nameOf(st, st.active));
		sub = _('The house uses the ISP connection, and goes back into the VPN by itself when it answers.');
	}
	else {
		colour = '#1565c0';
		title = _('Connecting to %s…').format(nameOf(st, st.active));
		sub = _('The house uses the ISP connection until the VPN answers, usually a few seconds.');
	}

	return E('div', { 'class': 'vpnf-banner', 'style': 'border-left-color:' + colour }, [
		E('div', {}, [
			E('div', { 'class': 'vpnf-title' }, [ title ]),
			E('div', { 'class': 'vpnf-sub' }, [ sub ])
		])
	]);
}

return view.extend({
	load: function() {
		return Promise.all([
			getStatus(),
			uci.load('dhcp')
		]);
	},

	// run one action of the tool, then show the new state; errors go into a notification
	act: function(args, failed) {
		this.busy = true;

		return runTool(args).catch(function(e) {
			ui.addNotification(null, E('p', {}, [ failed.format(e.message) ]), 'error');
		}).then(L.bind(function() {
			this.busy = false;
			this.changedAt = Date.now();
			return this.refresh();
		}, this));
	},

	refresh: function() {
		return getStatus().then(L.bind(this.paint, this));
	},

	paint: function(st) {
		// the watchdog restarts when the VPN changes: for those seconds it is connecting, not broken
		st.justChanged = (Date.now() - (this.changedAt || 0)) < 15000;
		dom.content(this.bannerBox, renderBanner(st));
		dom.content(this.listBox, this.renderList(st));
	},

	handleUse: function(id) {
		return this.act([ 'use', id ], _('The VPN was not changed: %s'));
	},

	handleDelete: function(id) {
		ui.hideModal();
		return this.act([ 'delete', id ], _('The VPN was not deleted: %s'));
	},

	askDelete: function(profile) {
		ui.showModal(_('Delete this VPN?'), [
			E('p', {}, [ _('%s is forgotten, with its key. To use it again you need its file again.').format(profile.name) ]),
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

	renderCard: function(st, id, name, detail, profile) {
		var active = (st.active || 'none') === id;
		var right = [];

		if (!active)
			right.push(E('button', {
				'class': 'btn cbi-button-action',
				'click': ui.createHandlerFn(this, 'handleUse', id)
			}, [ _('Use') ]));

		if (profile)
			right.push(E('button', {
				'class': 'btn cbi-button-negative',
				'click': ui.createHandlerFn(this, 'askDelete', profile)
			}, [ _('Delete') ]));

		return E('div', { 'class': 'vpnf-card' + (active ? ' vpnf-active' : '') }, [
			E('div', { 'class': 'vpnf-dot' }),
			E('div', { 'class': 'vpnf-grow' }, [
				E('div', { 'class': 'vpnf-name' }, [
					name,
					active ? E('span', { 'class': 'vpnf-badge' }, [ _('IN USE') ]) : ''
				]),
				E('div', { 'class': 'vpnf-sub' }, [ detail ])
			])
		].concat(right));
	},

	renderList: function(st) {
		var cards = [
			this.renderCard(st, 'none', _('No VPN'), _('The house uses the ISP connection.'), null)
		];

		(st.profiles || []).forEach(L.bind(function(p) {
			var detail = p.endpoint;

			if (st.active === p.id)
				detail += ' · ' + (st.handshake
					? _('last contact with the server %s ago').format(age(st, st.handshake))
					: _('no contact with the server yet'));

			cards.push(this.renderCard(st, p.id, p.name, detail, p));
		}, this));

		return E('div', { 'class': 'vpnf-list' }, cards);
	},

	handleAdd: function(nameInput, fileInput, textarea, panel) {
		var name = nameInput.value.replace(/\s+/g, ' ').trim();
		var read;

		if (textarea.value.trim())
			read = Promise.resolve(textarea.value);
		else if (fileInput.files[0])
			read = fileInput.files[0].text();
		else {
			ui.addNotification(null, E('p', {}, [ _('Choose the WireGuard file of the VPN first.') ]), 'warning');
			return;
		}

		if (!name && fileInput.files[0])
			name = fileInput.files[0].name.replace(/\.[^.]*$/, '');

		this.busy = true;

		return read.then(function(text) {
			// 384 is mode 0600: the file holds the private key until the tool deletes it
			return fs.write(IMPORT_FILE, (name ? '# Name = ' + name + '\n' : '') + text.trim() + '\n', 384);
		}).then(function() {
			return runTool([ 'add', IMPORT_FILE ]);
		}).then(function() {
			nameInput.value = '';
			fileInput.value = '';
			textarea.value = '';
			panel.style.display = 'none';
		}).catch(function(e) {
			ui.addNotification(null, E('p', {}, [ _('The VPN was not added: %s').format(e.message) ]), 'error');
		}).then(L.bind(function() {
			this.busy = false;
			this.changedAt = Date.now();
			return this.refresh();
		}, this));
	},

	renderAdd: function() {
		var nameInput = E('input', { 'type': 'text', 'class': 'cbi-input-text', 'maxlength': 30, 'placeholder': _('for example: Singapore') });
		var fileInput = E('input', { 'type': 'file', 'accept': '.conf,text/plain' });
		var textarea = E('textarea', {
			'class': 'cbi-input-textarea',
			'rows': 9,
			'spellcheck': 'false',
			'placeholder': '[Interface]\nPrivateKey = ...\nAddress = ...\nDNS = ...\n\n[Peer]\nPublicKey = ...\nAllowedIPs = 0.0.0.0/0\nEndpoint = 203.0.113.9:51820'
		});
		var panel = E('div', { 'class': 'vpnf-add', 'style': 'display:none' });

		dom.content(panel, [
			E('label', {}, [ _('WireGuard file of the VPN') ]),
			fileInput,
			E('label', {}, [ _('Name') ]),
			nameInput,
			E('details', {}, [
				E('summary', {}, [ _('No file? Paste its text instead') ]),
				textarea
			]),
			E('div', { 'class': 'vpnf-actions' }, [
				E('button', {
					'class': 'btn cbi-button-action',
					'click': ui.createHandlerFn(this, 'handleAdd', nameInput, fileInput, textarea, panel)
				}, [ _('Add') ]),
				E('button', { 'class': 'btn', 'click': function() { panel.style.display = 'none'; } }, [ _('Cancel') ])
			])
		]);

		return [
			E('p', {}, [
				E('button', {
					'class': 'btn cbi-button-add',
					'click': function() { panel.style.display = ''; nameInput.focus(); }
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
		s.tab('devices', _('Devices that skip the VPN'));
		s.tab('checks', _('Checks (advanced)'));

		o = s.taboption('devices', form.DynamicList, 'direct_ip', _('Devices'),
			_('These devices always use the ISP connection. A device is recognised by its address, so give it a static lease first (Network, DHCP and DNS).'));
		o.datatype = 'ip4addr("nomask")';
		uci.sections('dhcp', 'host', function(host) {
			L.toArray(host.ip).forEach(function(ip) {
				if (ip && ip.indexOf(':') < 0)
					o.value(ip, '%s (%s)'.format(host.name || L.toArray(host.mac).join(' ') || '?', ip));
			});
		});

		o = s.taboption('checks', form.DynamicList, 'probe_target', _('Addresses to ping through the VPN'),
			_('The VPN counts as answering when one of them replies.'));
		o.datatype = 'ip4addr("nomask")';
		o.placeholder = '1.1.1.1';

		o = s.taboption('checks', form.Value, 'interval', _('Seconds between two checks'));
		o.datatype = 'range(2,300)';
		o.placeholder = '10';

		o = s.taboption('checks', form.Value, 'down_after', _('Failed checks before falling back'),
			_('In a row. A failed check also waits two seconds for each address, so with the defaults the house is back on the ISP connection 30 to 40 seconds after the VPN stops answering.'));
		o.datatype = 'range(1,20)';
		o.placeholder = '3';

		o = s.taboption('checks', form.Value, 'up_after', _('Good checks before going into the VPN'));
		o.datatype = 'range(1,20)';
		o.placeholder = '2';

		this.bannerBox = E('div');
		this.listBox = E('div');
		this.paint(st);

		poll.add(L.bind(function() {
			// not in the middle of an action: its button would lose its spinner
			if (!this.busy)
				return this.refresh();
		}, this), 5);

		return m.render().then(L.bind(function(mapEl) {
			return E('div', {}, [
				E('style', {}, [ CSS ]),
				E('h2', {}, [ _('VPN') ]),
				E('div', { 'class': 'cbi-map-descr' }, [
					_('The whole house goes through the VPN you choose. While that VPN does not answer, the house uses the ISP connection.')
				]),
				this.bannerBox,
				E('h3', {}, [ _('Choose a VPN') ]),
				this.listBox
			].concat(this.renderAdd(), [ mapEl ]));
		}, this));
	}
});
