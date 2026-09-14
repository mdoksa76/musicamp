import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Cairo from 'gi://cairo';
import Gst from 'gi://Gst';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

// ============================================================================
// MUSIC PLAYER CLASS - Backend logic
// ============================================================================
class MusicPlayer {
    constructor(extensionPath, settings) {
        this.extensionPath = extensionPath;
        this.settings = settings;
        this.player = null;
        this.currentTrack = 0;
        this.isPlaying = false;
        this.isMuted = false;
        
        this.loopEnabled = this.settings.get_boolean('loop-enabled');
        this.shuffleEnabled = this.settings.get_boolean('shuffle-enabled');
        this.volume = this.settings.get_double('volume');
        
        this.tabs = [];
        this.activeTab = 0;      // tab koji korisnik trenutno GLEDA
        this.playingTab = 0;     // tab iz kojeg se stvarno REPRODUCIRA
        this.shuffledPlaylist = [];
        
        this.duration = 0;
        this.position = 0;
        this.progressUpdateId = null;
        this._pendingTimeouts = [];
        
        this._initPlayer();
        this._loadPlaylist();
    }
    
    // playlist = pjesme taba koji SVIRA (koriste play/next/prev/onTrackEnded/progress).
    get playlist() {
        if (this.playingTab < 0 || this.playingTab >= this.tabs.length) return [];
        return this.tabs[this.playingTab].tracks;
    }
    set playlist(tracks) {
        if (this.playingTab < 0 || this.playingTab >= this.tabs.length) return;
        this.tabs[this.playingTab].tracks = tracks;
    }

    // viewTracks = pjesme taba koji korisnik GLEDA (koristi UI za popis/uređivanje).
    get viewTracks() {
        if (this.activeTab < 0 || this.activeTab >= this.tabs.length) return [];
        return this.tabs[this.activeTab].tracks;
    }
    set viewTracks(tracks) {
        if (this.activeTab < 0 || this.activeTab >= this.tabs.length) return;
        this.tabs[this.activeTab].tracks = tracks;
    }

    _initPlayer() {
        if (!Gst.is_initialized()) {
            Gst.init(null);
        }
        
        this.player = Gst.ElementFactory.make('playbin', 'player');
        
        if (!this.player) {
            console.error('🎵 Failed to create GStreamer playbin element');
            return;
        }
        
        this.player.set_property('volume', this.volume);
        
        let bus = this.player.get_bus();
        bus.add_signal_watch();
        this._bus = bus;
        this._busSignalId = bus.connect('message', (bus, message) => {
            switch (message.type) {
                case Gst.MessageType.EOS:
                    console.debug('🎵 GStreamer EOS received');
                    this._onTrackEnded();
                    break;
                    
                case Gst.MessageType.ERROR:
                    let [err, debug] = message.parse_error();
                    console.error(`🎵 GStreamer error: ${err.message} (${debug})`);
                    this._onTrackEnded(); // Na grešku, pokreni sljedeću pjesmu
                    break;
                    
                case Gst.MessageType.STATE_CHANGED:
                    if (message.src === this.player) {
                        let [old, newState, pending] = message.parse_state_changed();
                        // Ako se vratimo na NULL stanje (kraj pjesme)
                        if (newState === Gst.State.NULL && old === Gst.State.PLAYING) {
                            console.debug('🎵 GStreamer state changed to NULL from PLAYING');
                            this._onTrackEnded();
                        }
                    }
                    break;
                    
                case Gst.MessageType.DURATION_CHANGED:
                    this._updateDuration();
                    break;
            }
        });
        
        console.debug('🎵 MusicAMP Player initialized');
    }
    
    _loadPlaylist() {
        this.tabs = [];
        this.activeTab = 0;

        let playlistJson = this.settings.get_string('music-playlist');
        if (playlistJson && playlistJson !== '[]' && playlistJson !== '') {
            try {
                let parsed = JSON.parse(playlistJson);

                if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].tracks !== undefined) {
                    // Novi format: niz tabova
                    parsed.forEach(tab => {
                        this.tabs.push({
                            name: tab.name || 'Playlist',
                            tracks: (tab.tracks || []).map(track => ({
                                name: track.name,
                                uri: track.uri,
                                enabled: track.enabled !== false
                            }))
                        });
                    });
                } else if (Array.isArray(parsed)) {
                    // Stari format: goli niz pjesama -> zamotaj u tab 0
                    this.tabs.push({
                        name: 'Playlist',
                        tracks: parsed.map(track => ({
                            name: track.name,
                            uri: track.uri,
                            enabled: track.enabled !== false
                        }))
                    });
                }
            } catch (e) {
                console.error('🎵 Error loading playlist: ' + e.message);
            }
        }

        // Tab 0 je trajni default - uvijek postoji
        if (this.tabs.length === 0) {
            this.tabs.push({ name: 'Playlist', tracks: [] });
        }

        this._updateShuffledPlaylist();
        console.debug(`🎵 Loaded ${this.tabs.length} tab(s), active tab has ${this.playlist.length} songs`);
    }

    savePlaylist() {
        let allTabs = this.tabs.map(tab => ({
            name: tab.name,
            tracks: tab.tracks.map(track => ({
                name: track.name,
                uri: track.uri,
                enabled: track.enabled
            }))
        }));

        let playlistJson = JSON.stringify(allTabs);
        this.settings.set_string('music-playlist', playlistJson);
        console.debug('🎵 Playlist saved');
    }

    // --- Tab upravljanje ---
    addTab(name) {
        this.tabs.push({ name: name || `Tab ${this.tabs.length + 1}`, tracks: [] });
        this.activeTab = this.tabs.length - 1;
        this.savePlaylist();
        console.debug(`🎵 Tab added: ${name}`);
    }

    removeTab(index) {
        // Tab 0 je trajni default - ne briše se
        if (index <= 0 || index >= this.tabs.length) return;

        // Zaustavi reprodukciju samo ako brišemo tab koji svira
        let removingPlayingTab = (index === this.playingTab);
        if (removingPlayingTab) {
            this.stop();
            this.currentTrack = 0;
        }

        this.tabs.splice(index, 1);

        // Pomakni activeTab (gledani)
        if (this.activeTab >= this.tabs.length) {
            this.activeTab = this.tabs.length - 1;
        } else if (this.activeTab === index) {
            this.activeTab = Math.max(0, index - 1);
        } else if (this.activeTab > index) {
            this.activeTab--;
        }

        // Pomakni playingTab da ostane valjan
        if (removingPlayingTab) {
            this.playingTab = this.activeTab;
        } else if (this.playingTab > index) {
            this.playingTab--;
        }

        this._updateShuffledPlaylist();
        this.savePlaylist();
        console.debug(`🎵 Tab removed: ${index}`);
    }

    switchTab(index) {
        if (index < 0 || index >= this.tabs.length) return;
        if (index === this.activeTab) return;
        // Samo mijenjamo GLEDANI tab - reprodukcija iz playingTab se ne prekida.
        this.activeTab = index;
        console.debug(`🎵 Viewing tab: ${this.tabs[index].name}`);
    }
    
    _updateShuffledPlaylist() {
        if (!this.shuffleEnabled) {
            this.shuffledPlaylist = [];
            return;
        }
        
        // Create array of enabled track indices
        let enabledIndices = [];
        this.playlist.forEach((track, idx) => {
            if (track.enabled) enabledIndices.push(idx);
        });
        
        // Fisher-Yates shuffle
        for (let i = enabledIndices.length - 1; i > 0; i--) {
            let j = Math.floor(Math.random() * (i + 1));
            [enabledIndices[i], enabledIndices[j]] = [enabledIndices[j], enabledIndices[i]];
        }
        
        this.shuffledPlaylist = enabledIndices;
    }
    
    _updateDuration() {
        if (!this.player) return;
        
        let [success, duration] = this.player.query_duration(Gst.Format.TIME);
        if (success && duration > 0) {
            this.duration = duration / Gst.SECOND;
        } else {
            this.duration = 0;
        }
    }
    
    _startProgressUpdates() {
        if (this.progressUpdateId) return;
        
        this.progressUpdateId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
            if (!this.isPlaying || !this.player) {
                return GLib.SOURCE_CONTINUE;
            }
            
            // Provjeri da li je pjesma završila (manualna detekcija)
            if (this.duration > 0 && this.position >= this.duration - 0.5) {
                console.debug('🎵 Manual track end detection');
                this._onTrackEnded();
                return GLib.SOURCE_CONTINUE;
            }
            
            let [success, position] = this.player.query_position(Gst.Format.TIME);
            if (success) {
                this.position = position / Gst.SECOND;
            }
            
            if (this.duration === 0) {
                let [dSuccess, duration] = this.player.query_duration(Gst.Format.TIME);
                if (dSuccess && duration > 0) {
                    this.duration = duration / Gst.SECOND;
                }
            }
            
            return GLib.SOURCE_CONTINUE;
        });
    }
    
    _stopProgressUpdates() {
        if (this.progressUpdateId) {
            GLib.source_remove(this.progressUpdateId);
            this.progressUpdateId = null;
        }
        this.position = 0;
        this.duration = 0;
    }
    
    getProgress() {
        return {
            position: this.position,
            duration: this.duration,
            percentage: this.duration > 0 ? (this.position / this.duration) * 100 : 0
        };
    }
    
    _onTrackEnded() {
        console.debug('🎵 Track ended, moving to next track');
        this._stopProgressUpdates();
        
        if (this.player) {
            this.player.set_state(Gst.State.NULL);
        }
        
        this.isPlaying = false;
        
        // Kratki delay prije sljedeće pjesme
        let timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
            this._pendingTimeouts = this._pendingTimeouts.filter(id => id !== timeoutId);
            if (this.loopEnabled) {
                this.next();
            } else {
                this.stop();
                // Ipak pokreni sljedeću za kontinuirani playback
                this.next();
            }
            return GLib.SOURCE_REMOVE;
        });
        this._pendingTimeouts.push(timeoutId);
    }
    
    play() {
        if (!this.player || this.playlist.length === 0) {
            console.debug('🎵 Cannot play - no player or empty playlist');
            return;
        }
        
        // Ako već svira, samo nastavi
        if (this.isPlaying) {
            this.player.set_state(Gst.State.PLAYING);
            this._startProgressUpdates();
            console.debug('🎵 Resumed playback');
            return;
        }
        
        let track = this.playlist[this.currentTrack];
        if (!track || !track.enabled) {
            this.currentTrack = this._findNextEnabledTrack();
            if (this.currentTrack === -1) {
                console.debug('🎵 No enabled tracks in playlist');
                return;
            }
            track = this.playlist[this.currentTrack];
        }
        
        console.debug(`🎵 Playing: ${track.name} (URI: ${track.uri})`);
        
        try {
            // Zaustavi prijašnju pjesmu ako je bila aktivna
            if (this.player.get_state(0)[1] !== Gst.State.NULL) {
                this.player.set_state(Gst.State.NULL);
            }
            
            // Postavi novi URI
            this.player.set_property('uri', track.uri);
            
            // Pokreni playback
            let stateChange = this.player.set_state(Gst.State.PLAYING);
            if (stateChange === Gst.StateChangeReturn.FAILURE) {
                console.error('🎵 Failed to start playback');
                this._onTrackEnded(); // Pokušaj sljedeću pjesmu
                return;
            }
            
            this.isPlaying = true;
            
            this._updateDuration();
            this._startProgressUpdates();
            
        } catch (e) {
            console.error(`🎵 Error playing track: ${e.message}`);
            this._onTrackEnded(); // Pokušaj sljedeću pjesmu
        }
    }
    
    playTrack(index) {
        // Klik na pjesmu u gledanom tabu -> reprodukcija prelazi na taj tab.
        if (this.playingTab !== this.activeTab) {
            this.playingTab = this.activeTab;
            this._updateShuffledPlaylist();
        }
        if (index < 0 || index >= this.playlist.length) return;
        if (!this.playlist[index].enabled) return;

        console.debug(`🎵 Play track requested: ${index} (tab ${this.playingTab})`);
        this.stop();
        this.currentTrack = index;

        let tid = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
            this._pendingTimeouts = this._pendingTimeouts.filter(id => id !== tid);
            this.play();
            return GLib.SOURCE_REMOVE;
        });
        this._pendingTimeouts.push(tid);
    }

    pause() {
        if (!this.player) return;
        
        this.player.set_state(Gst.State.PAUSED);
        this.isPlaying = false;
        this._stopProgressUpdates();
        console.debug('🎵 Paused');
    }
    
    stop() {
        if (!this.player) return;
        
        this.player.set_state(Gst.State.NULL);
        this.isPlaying = false;
        this._stopProgressUpdates();
        console.debug('🎵 Stopped');
    }
    
    next() {
        console.debug('🎵 Next track requested');
        this.stop(); // Zaustavi trenutnu
        
        let nextTrack = this._findNextEnabledTrack();
        if (nextTrack !== -1) {
            this.currentTrack = nextTrack;
            console.debug(`🎵 Next track index: ${nextTrack}`);
            // Kratki delay da se GStreamer stabilizira
            let nextTid = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
                this._pendingTimeouts = this._pendingTimeouts.filter(id => id !== nextTid);
                this.play();
                return GLib.SOURCE_REMOVE;
            });
            this._pendingTimeouts.push(nextTid);
        } else {
            console.debug('🎵 No next track available');
        }
    }
    
    previous() {
        console.debug('🎵 Previous track requested');
        this.stop(); // Zaustavi trenutnu
        
        let prevTrack = this._findPreviousEnabledTrack();
        if (prevTrack !== -1) {
            this.currentTrack = prevTrack;
            console.debug(`🎵 Previous track index: ${prevTrack}`);
            // Kratki delay da se GStreamer stabilizira
            let prevTid = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
                this._pendingTimeouts = this._pendingTimeouts.filter(id => id !== prevTid);
                this.play();
                return GLib.SOURCE_REMOVE;
            });
            this._pendingTimeouts.push(prevTid);
        } else {
            console.debug('🎵 No previous track available');
        }
    }
    
    _findPreviousEnabledTrack() {
        if (this.playlist.length === 0) return -1;
        
        if (this.shuffleEnabled && this.shuffledPlaylist.length > 0) {
            let currentShuffleIdx = this.shuffledPlaylist.indexOf(this.currentTrack);
            if (currentShuffleIdx > 0) {
                return this.shuffledPlaylist[currentShuffleIdx - 1];
            }
            return this.shuffledPlaylist[this.shuffledPlaylist.length - 1];
        }
        
        let startIndex = this.currentTrack - 1;
        if (startIndex < 0) startIndex = this.playlist.length - 1;
        
        for (let i = 0; i < this.playlist.length; i++) {
            let index = (startIndex - i);
            if (index < 0) index += this.playlist.length;
            
            if (this.playlist[index].enabled) {
                return index;
            }
        }
        
        return -1;
    }
    
    _findNextEnabledTrack() {
        if (this.playlist.length === 0) return -1;
        
        if (this.shuffleEnabled && this.shuffledPlaylist.length > 0) {
            let currentShuffleIdx = this.shuffledPlaylist.indexOf(this.currentTrack);
            if (currentShuffleIdx < this.shuffledPlaylist.length - 1) {
                return this.shuffledPlaylist[currentShuffleIdx + 1];
            }
            // Reshuffle and start over
            this._updateShuffledPlaylist();
            return this.shuffledPlaylist.length > 0 ? this.shuffledPlaylist[0] : -1;
        }
        
        let startIndex = (this.currentTrack + 1) % this.playlist.length;
        
        for (let i = 0; i < this.playlist.length; i++) {
            let index = (startIndex + i) % this.playlist.length;
            if (this.playlist[index].enabled) {
                return index;
            }
        }
        
        return -1;
    }
    
    toggleMute() {
        if (!this.player) return;
        
        this.isMuted = !this.isMuted;
        
        if (this.isMuted) {
            this.player.set_property('volume', 0.0);
            console.debug('🎵 Muted');
        } else {
            this.player.set_property('volume', this.volume);
            console.debug('🎵 Unmuted');
        }
    }
    
    toggleLoop() {
        this.loopEnabled = !this.loopEnabled;
        this.settings.set_boolean('loop-enabled', this.loopEnabled);
        console.debug(`🎵 Loop: ${this.loopEnabled ? 'ON' : 'OFF'}`);
    }
    
    toggleShuffle() {
        this.shuffleEnabled = !this.shuffleEnabled;
        this.settings.set_boolean('shuffle-enabled', this.shuffleEnabled);
        this._updateShuffledPlaylist();
        console.debug(`🎵 Shuffle: ${this.shuffleEnabled ? 'ON' : 'OFF'}`);
    }
    
    setVolume(volume) {
        this.volume = Math.max(0.0, Math.min(1.0, volume));
        this.settings.set_double('volume', this.volume);
        
        if (!this.isMuted && this.player) {
            this.player.set_property('volume', this.volume);
        }
    }
    
    removeTrack(index) {
        if (index < 0 || index >= this.viewTracks.length) return;
        
        console.debug(`🎵 Removing: ${this.viewTracks[index].name}`);
        this.viewTracks.splice(index, 1);
        
        // currentTrack pripada tabu koji svira - prilagodi samo ako gledamo taj tab
        if (this.activeTab === this.playingTab && this.currentTrack >= index) {
            this.currentTrack = Math.max(0, this.currentTrack - 1);
        }
        
        this._updateShuffledPlaylist();
        this.savePlaylist();
    }
    
    getCurrentTrackName() {
        if (this.playlist.length === 0) return 'No tracks';
        if (this.currentTrack >= this.playlist.length) return 'Unknown';
        
        return this.playlist[this.currentTrack].name;
    }
    
    destroy() {
        this._stopProgressUpdates();
        
        // Ukloni sve pending jednoratne timeoute
        this._pendingTimeouts.forEach(id => GLib.source_remove(id));
        this._pendingTimeouts = [];
        
        // Disconnect bus signal
        if (this._bus && this._busSignalId) {
            this._bus.disconnect(this._busSignalId);
            this._bus.remove_signal_watch();
            this._busSignalId = null;
            this._bus = null;
        }
        
        if (this.player) {
            this.player.set_state(Gst.State.NULL);
            this.player = null;
        }
        
        console.debug('🎵 MusicAMP Player destroyed');
    }
}

// ============================================================================
// MUSIC INDICATOR CLASS - Panel UI
// ============================================================================
const MusicIndicator = GObject.registerClass(
class MusicIndicator extends PanelMenu.Button {
    _init(musicPlayer) {
        super._init(0.0, 'MusicAMP Player', false);
        
        this.musicPlayer = musicPlayer;
        
        // Panel icon - zadržavamo znak melodije 🎵
        this._icon = new St.Label({
            text: '🎵',
            y_align: Clutter.ActorAlign.CENTER,
            style: 'font-size: 16px;'
        });
        
        this.add_child(this._icon);
        
        // Build menu
        this._buildMenu();
    }
    
    _buildMenu() {
        // Title
        let titleItem = new PopupMenu.PopupMenuItem('🎵 MusicAMP Player', {
            reactive: false,
            can_focus: false
        });
        titleItem.label.style = 'font-weight: bold;';
        this.menu.addMenuItem(titleItem);
        
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        
        // Current track display
        this._trackLabel = new PopupMenu.PopupMenuItem('♪ No track playing', {
            reactive: false,
            can_focus: false
        });
        this.menu.addMenuItem(this._trackLabel);
        
        // Control buttons - ALL IN ONE ROW
        let controlBox = new St.BoxLayout({
            style_class: 'popup-menu-item',
            style: 'padding: 5px; spacing: 4px;'
        });

        // Play/Pause button
        this._playButton = new St.Button({
            label: '▶️ Play',
            style_class: 'button',
            x_expand: false,
            style: 'min-width: 85px; max-width: 85px; width: 85px; height: 28px; padding: 0px 8px;'
        });
        this._playButton.connectObject('clicked', () => {
            if (this.musicPlayer.isPlaying) {
                this.musicPlayer.pause();
                this._playButton.label = '▶️ Play';
            } else {
                this.musicPlayer.play();
                this._playButton.label = '⏸️ Pause';
                this._updateTrackLabel();
            }
        }, this);
        controlBox.add_child(this._playButton);

        // Stop button
        this._stopButton = new St.Button({
            label: '⏹️ Stop',
            style_class: 'button',
            x_expand: false,
            style: 'min-width: 80px; max-width: 80px; width: 80px; height: 28px; padding: 0px 8px;'
        });
        this._stopButton.connectObject('clicked', () => {
            this.musicPlayer.stop();
            this._playButton.label = '▶️ Play';
            this._updateTrackLabel();
        }, this);
        controlBox.add_child(this._stopButton);

        // Previous button
        let prevButton = new St.Button({
            label: '⏮️ Prev',
            style_class: 'button',
            x_expand: false,
            style: 'min-width: 80px; max-width: 80px; width: 80px; height: 28px; padding: 0px 8px;'
        });
        prevButton.connectObject('clicked', () => {
            this.musicPlayer.previous();
            if (this.musicPlayer.isPlaying) {
                this._playButton.label = '⏸️ Pause';
            }
            this._updateTrackLabel();
        }, this);
        controlBox.add_child(prevButton);

        // Next button
        let nextButton = new St.Button({
            label: '⏭️ Next',
            style_class: 'button',
            x_expand: false,
            style: 'min-width: 80px; max-width: 80px; width: 80px; height: 28px; padding: 0px 8px;'
        });
        nextButton.connectObject('clicked', () => {
            this.musicPlayer.next();
            if (this.musicPlayer.isPlaying) {
                this._playButton.label = '⏸️ Pause';
            }
            this._updateTrackLabel();
        }, this);
        controlBox.add_child(nextButton);

        // Mute button
        this._muteButton = new St.Button({
            label: '🔊 Mute',
            style_class: 'button',
            x_expand: false,
            style: 'min-width: 85px; max-width: 85px; width: 85px; height: 28px; padding: 0px 8px;'
        });
        this._muteButton.connectObject('clicked', () => {
            this.musicPlayer.toggleMute();
            this._muteButton.label = this.musicPlayer.isMuted ? '🔇 Unmute' : '🔊 Mute';
        }, this);
        controlBox.add_child(this._muteButton);

        // Loop button
        this._loopButton = new St.Button({
            label: '🔁 Loop: ON',
            style_class: 'button',
            x_expand: false,
            style: 'min-width: 110px; max-width: 110px; width: 110px; height: 28px; padding: 0px 8px; color: #4CAF50;'
        });
        this._loopButton.connectObject('clicked', () => {
            this.musicPlayer.toggleLoop();
            if (this.musicPlayer.loopEnabled) {
                this._loopButton.label = '🔁 Loop: ON';
                this._loopButton.style = 'min-width: 95px; max-width: 95px; width: 95px; height: 28px; padding: 0px 8px; color: #4CAF50;';
            } else {
                this._loopButton.label = '🔁 Loop: OFF';
                this._loopButton.style = 'min-width: 95px; max-width: 95px; width: 95px; height: 28px; padding: 0px 8px; color: #888;';
            }
        }, this);
        controlBox.add_child(this._loopButton);

        // Shuffle button (NOVO!)
        this._shuffleButton = new St.Button({
            label: '🔀 Shuffle: OFF',
            style_class: 'button',
            x_expand: false,
            style: 'min-width: 120px; max-width: 120px; width: 105px; height: 28px; padding: 0px 8px; color: #888;'
        });
        this._shuffleButton.connectObject('clicked', () => {
            this.musicPlayer.toggleShuffle();
            if (this.musicPlayer.shuffleEnabled) {
                this._shuffleButton.label = '🔀 Shuffle: ON';
                this._shuffleButton.style = 'min-width: 120px; max-width: 120px; width: 120px; height: 28px; padding: 0px 8px; color: #FF8800;';
            } else {
                this._shuffleButton.label = '🔀 Shuffle: OFF';
                this._shuffleButton.style = 'min-width: 120px; max-width: 120px; width: 120px; height: 28px; padding: 0px 8px; color: #888;';
            }
        }, this);
        controlBox.add_child(this._shuffleButton);
        
        let controlItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false
        });
        controlItem.actor.add_child(controlBox);
        this.menu.addMenuItem(controlItem);
        this._controlBox = controlBox;
        
        // Progress bar - HORIZONTAL sa vremenom
        let progressBox = new St.BoxLayout({
            style: 'padding: 5px 10px; spacing: 10px;',
            vertical: false,
            x_expand: true
        });
        
        // Time label
        this._progressLabel = new St.Label({
            text: '00:00 / 00:00',
            style: 'font-size: 11px; color: #888; min-width: 80px;',
            y_align: Clutter.ActorAlign.CENTER
        });
        progressBox.add_child(this._progressLabel);
        
        // Separator |
        let separator = new St.Label({
            text: '│',
            style: 'color: #555;',
            y_align: Clutter.ActorAlign.CENTER
        });
        progressBox.add_child(separator);
        
        // Progress bar
        this._progressBar = new St.DrawingArea({
            style: 'height: 6px;',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER
        });
        this._progressBar.connectObject('repaint', (area) => {
            this._drawProgressBar(area);
        }, this);
        progressBox.add_child(this._progressBar);
        
        let progressItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false
        });
        progressItem.actor.add_child(progressBox);
        this.menu.addMenuItem(progressItem);
        
        // Start progress update timer
        this._progressUpdateId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
            this._updateProgress();
            return GLib.SOURCE_CONTINUE;
        });
        
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        
        // Tab row (iznad playliste) - horizontalni scroll kad tabova ima previše
        this._tabsItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false
        });
        this._tabsBox = new St.BoxLayout({
            style: 'spacing: 4px; padding: 2px 0px;',
            x_expand: false,
            x_align: Clutter.ActorAlign.START,
            vertical: false
        });
        let tabsScroll = new St.ScrollView({
            hscrollbar_policy: St.PolicyType.AUTOMATIC,
            vscrollbar_policy: St.PolicyType.NEVER,
            x_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            clip_to_allocation: true,
            style: 'max-height: 40px;'
        });
        tabsScroll.add_child(this._tabsBox);
        this._tabsItem.actor.add_child(tabsScroll);
        this.menu.addMenuItem(this._tabsItem);
        this._tabsScroll = tabsScroll;

        // Playlist section
        let playlistLabel = new PopupMenu.PopupMenuItem('📋 Playlist:', {
            reactive: false,
            can_focus: false
        });
        playlistLabel.label.style = 'font-weight: bold;';
        this.menu.addMenuItem(playlistLabel);
        
        // Scrollable playlist container
        this._playlistSection = new PopupMenu.PopupMenuSection();
        let scrollView = new St.ScrollView({
            style: 'max-height: 500px;',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC
        });
        scrollView.add_child(this._playlistSection.actor);
        
        let scrollItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false
        });
        scrollItem.actor.add_child(scrollView);
        this.menu.addMenuItem(scrollItem);
        
        // Build playlist on first menu open
        let firstOpen = true;
        this.menu.connectObject('open-state-changed', (menu, open) => {
            if (open) {
                if (firstOpen) {
                    this._buildTabs();
                    this._buildPlaylistItems();
                    firstOpen = false;
                }
                this._playlistSection.actor.queue_relayout();

                // Ograniči širinu tab-scrolla na stvarnu širinu reda kontrola,
                // da dodavanje tabova ne širi meni nego aktivira h-scroll.
                this._refreshTabsWidth();
            }
        }, this);
        
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        
        // Add music file button
        let addFileItem = new PopupMenu.PopupMenuItem('➕ Add Music File...');
        addFileItem.connectObject('activate', () => {
            this._openFilePicker();
        }, this);
        this.menu.addMenuItem(addFileItem);
        
        // Add music folder button
        let addFolderItem = new PopupMenu.PopupMenuItem('📁 Add Music Folder...');
        addFolderItem.connectObject('activate', () => {
            this._openFolderPicker();
        }, this);
        this.menu.addMenuItem(addFolderItem);

        // Add Tab button
        let addTabItem = new PopupMenu.PopupMenuItem('🗂️ Add Tab...');
        addTabItem.connectObject('activate', () => {
            this._addTab();
        }, this);
        this.menu.addMenuItem(addTabItem);

        // Clear playlist button
        let clearPlaylistItem = new PopupMenu.PopupMenuItem('🗑️ Clear Playlist');
        clearPlaylistItem.connectObject('activate', () => {
            this._clearPlaylist();
        }, this);
        this.menu.addMenuItem(clearPlaylistItem);
    }

    _buildTabs() {
        this._tabsBox.destroy_all_children();

        this.musicPlayer.tabs.forEach((tab, index) => {
            let isActive = (index === this.musicPlayer.activeTab);
            let minW = Math.max(50, tab.name.length * 8 + 24);
            let tabBtn = new St.Button({
                label: tab.name,
                style_class: 'button',
                x_expand: false,
                style: (isActive
                    ? 'padding: 2px 10px; height: 26px; color: #FF8800; font-weight: bold;'
                    : 'padding: 2px 10px; height: 26px; color: #ccc;')
                    + ` min-width: ${minW}px;`
            });
            tabBtn.connect('clicked', () => {
                this.musicPlayer.switchTab(index);
                this._buildTabs();
                this._buildPlaylistItems();
                // Reprodukcija se ne prekida - gumb odražava stvarno stanje
                this._playButton.label = this.musicPlayer.isPlaying ? '⏸️ Pause' : '▶️ Play';
                this._updateTrackLabel();
            });
            this._tabsBox.add_child(tabBtn);

            // Tabovi 1+ imaju gumb za brisanje; tab 0 (default) nema
            if (index > 0) {
                let delBtn = new St.Button({
                    label: '✖',
                    style_class: 'button',
                    x_expand: false,
                    style: 'padding: 2px 4px; height: 26px; min-width: 22px; max-width: 22px; font-size: 9px; color: #ff5555;'
                });
                delBtn.connect('clicked', () => {
                    this._removeTab(index);
                });
                this._tabsBox.add_child(delBtn);
            }
        });
        this._refreshTabsWidth();
    }

    // Premjeri i primijeni širinu tab-scrolla na temelju reda kontrola.
    // Zove se nakon svake promjene tabova (dodaj/obriši/switch), ne samo na otvaranju.
    _refreshTabsWidth() {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
            if (this._controlBox && this._tabsScroll) {
                // Širina reda kontrola je konstanta (fiksni gumbi). Izmjeri je
                // JEDNOM i zaključaj - inače premjeravanje pri brisanju tabova
                // hvata prijelazne (manje) vrijednosti i linija se skraćuje.
                if (!this._lockedTabsWidth) {
                    let w = this._controlBox.get_width();
                    if (w > 0) this._lockedTabsWidth = w;
                }
                if (this._lockedTabsWidth) {
                    this._tabsScroll.style = `max-width: ${this._lockedTabsWidth}px; max-height: 40px;`;
                }
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _addTab() {
        let cmd = [
            'zenity', '--entry',
            '--title=Add Tab',
            '--text=Tab name:',
            '--width=350'
        ];
        try {
            let proc = Gio.Subprocess.new(
                cmd,
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
            );
            proc.communicate_utf8_async(null, null, (proc, res) => {
                try {
                    let [, stdout] = proc.communicate_utf8_finish(res);
                    if (proc.get_successful() && stdout) {
                        let name = stdout.trim();
                        if (name.length > 0) {
                            this.musicPlayer.addTab(name);
                            this._buildTabs();
                            this._buildPlaylistItems();
                            this._playButton.label = '▶️ Play';
                            this._updateTrackLabel();
                        }
                    }
                } catch (e) {
                    log('Error reading tab name: ' + e.message);
                }
            });
        } catch (e) {
            log('Error opening tab name dialog: ' + e.message);
        }
    }

    _removeTab(index) {
        let tabName = this.musicPlayer.tabs[index]?.name || '';
        let cmd = [
            'zenity', '--question',
            '--title=Remove Tab',
            `--text=Remove tab "${tabName}" and all its songs?`,
            '--width=400'
        ];
        try {
            let proc = Gio.Subprocess.new(
                cmd,
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
            );
            proc.communicate_utf8_async(null, null, (proc, res) => {
                try {
                    proc.communicate_utf8_finish(res);
                    if (proc.get_successful()) {
                        this.musicPlayer.removeTab(index);
                        this._buildTabs();
                        this._buildPlaylistItems();
                        this._playButton.label = '▶️ Play';
                        this._updateTrackLabel();
                    }
                } catch (e) {
                    log('Error in remove tab dialog: ' + e.message);
                }
            });
        } catch (e) {
            log('Error opening remove tab dialog: ' + e.message);
        }
    }
    
    _buildPlaylistItems() {
        // Clear existing playlist items
        if (this._playlistItems) {
            this._playlistItems.forEach(item => item.destroy());
        }
        this._playlistItems = [];
        
        this._playlistSection.removeAll();
        
        // Add each track with checkbox and remove button (iz GLEDANOG taba)
        this.musicPlayer.viewTracks.forEach((track, index) => {
            let rowBox = new St.BoxLayout({
                style: 'spacing: 8px; padding: 2px 0px; min-width: 750px;',
                x_expand: true,
                vertical: false
            });
            
            // Checkbox
            let checkbox = new St.Button({
                style_class: 'check-box',
                x_expand: false,
                can_focus: true,
                toggle_mode: true,
                checked: track.enabled
            });
            
            if (track.enabled) {
                checkbox.add_style_class_name('toggle-on');
            }
            
            checkbox.connect('clicked', () => {
                track.enabled = !track.enabled;
                this.musicPlayer.viewTracks[index].enabled = track.enabled;
                
                if (track.enabled) {
                    checkbox.add_style_class_name('toggle-on');
                } else {
                    checkbox.remove_style_class_name('toggle-on');
                }
                
                this.musicPlayer.savePlaylist();
                this.musicPlayer._updateShuffledPlaylist();
                log(`🎵 Track "${track.name}" ${track.enabled ? 'enabled' : 'disabled'}`);
            });
            
            rowBox.add_child(checkbox);
            
            // Track name - klikabilno za pokretanje pjesme (izgled kao obični sivi label)
            let nameLabel = new St.Button({
                label: track.name,
                x_expand: true,
                x_align: Clutter.ActorAlign.START,
                style: 'padding-left: 8px; background: none; border: none; box-shadow: none; font-weight: normal;'
            });
            nameLabel.connect('clicked', () => {
                this.musicPlayer.playTrack(index);
                this._playButton.label = '⏸️ Pause';
                this._buildPlaylistItems();
                this._updateTrackLabel();
            });
            rowBox.add_child(nameLabel);
            
            // Remove button
            let removeButton = new St.Button({
                label: '✖',
                style_class: 'button',
                style: 'padding: 2px 6px; font-size: 10px; color: #ff8800;',
                x_expand: false,
                x_align: Clutter.ActorAlign.END
            });
            removeButton.connect('clicked', () => {
                this.musicPlayer.removeTrack(index);
                this._buildPlaylistItems();
            });
            rowBox.add_child(removeButton);
            
            let rowItem = new PopupMenu.PopupBaseMenuItem({
                reactive: false,
                can_focus: false
            });
            rowItem.actor.style = 'padding: 2px 10px;';
            rowItem.actor.add_child(rowBox);
            
            this._playlistSection.addMenuItem(rowItem);
            this._playlistItems.push(rowItem);
        });
        
        if (this.musicPlayer.viewTracks.length === 0) {
            let emptyItem = new PopupMenu.PopupMenuItem('(No tracks in playlist)', {
                reactive: false,
                can_focus: false
            });
            emptyItem.label.style = 'font-style: italic; color: #888;';
            this._playlistSection.addMenuItem(emptyItem);
            this._playlistItems.push(emptyItem);
        }
    }
    
    _openFilePicker() {
        log('🎵 Opening file picker...');
        
        let cmd = [
            'zenity',
            '--file-selection',
            '--title=Select Music File',
            '--file-filter=Audio Files | *.mp3 *.ogg *.flac *.wav *.m4a *.aac *.wma',
            '--multiple',
            '--separator=\n'
        ];
        
        try {
            let proc = Gio.Subprocess.new(
                cmd,
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
            );
            
            proc.communicate_utf8_async(null, null, (proc, res) => {
                try {
                    let [, stdout, stderr] = proc.communicate_utf8_finish(res);
                    
                    if (proc.get_successful() && stdout) {
                        let files = stdout.trim().split('\n').filter(f => f.length > 0);
                        
                        files.forEach(filePath => {
                            this._addMusicFile(filePath);
                        });
                        
                        log(`🎵 Added ${files.length} file(s) to playlist`);
                        this._buildPlaylistItems();
                    }
                } catch (e) {
                    log('Error reading file picker output: ' + e.message);
                }
            });
            
        } catch (e) {
            log('Error opening file picker: ' + e.message);
        }
    }
    
    _addMusicFile(filePath) {
        let fileName = filePath.split('/').pop();
        let fileUri = `file://${filePath}`;
        
        this.musicPlayer.viewTracks.push({
            name: fileName,
            uri: fileUri,
            enabled: true
        });
        
        this.musicPlayer.savePlaylist();
        this.musicPlayer._updateShuffledPlaylist();
        
        log(`🎵 Added: ${fileName}`);
    }
    
    _openFolderPicker() {
        log('🎵 Opening folder picker...');
        
        let cmd = [
            'zenity',
            '--file-selection',
            '--title=Select Music Folder',
            '--directory'
        ];
        
        try {
            let proc = Gio.Subprocess.new(
                cmd,
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
            );
            
            proc.communicate_utf8_async(null, null, (proc, res) => {
                try {
                    let [, stdout, stderr] = proc.communicate_utf8_finish(res);
                    
                    if (proc.get_successful() && stdout) {
                        let folderPath = stdout.trim();
                        if (folderPath) {
                            this._scanMusicFolder(folderPath);
                        }
                    }
                } catch (e) {
                    log('Error reading folder picker output: ' + e.message);
                }
            });
            
        } catch (e) {
            log('Error opening folder picker: ' + e.message);
        }
    }
    
    _scanMusicFolder(folderPath) {
        log(`🎵 Scanning folder: ${folderPath}`);
        
        try {
            let folder = Gio.File.new_for_path(folderPath);
            let enumerator = folder.enumerate_children(
                'standard::name,standard::type',
                Gio.FileQueryInfoFlags.NONE,
                null
            );
            
            let audioExtensions = ['.mp3', '.ogg', '.flac', '.wav', '.m4a', '.aac', '.wma', '.opus'];
            let audioFiles = [];
            
            let fileInfo;
            while ((fileInfo = enumerator.next_file(null)) !== null) {
                let fileName = fileInfo.get_name();
                let fileType = fileInfo.get_file_type();
                
                // Skip directories
                if (fileType === Gio.FileType.DIRECTORY) {
                    continue;
                }
                
                // Check if file has audio extension
                let isAudio = audioExtensions.some(ext => 
                    fileName.toLowerCase().endsWith(ext)
                );
                
                if (isAudio) {
                    audioFiles.push(fileName);
                }
            }
            
            enumerator.close(null);
            
            // Sort alphabetically (A-Z) - perfect for "Artist - Song.mp3" format
            audioFiles.sort((a, b) => a.localeCompare(b, undefined, {sensitivity: 'base'}));
            
            // Add all audio files from folder to playlist
            audioFiles.forEach(fileName => {
                let filePath = folderPath + '/' + fileName;
                this._addMusicFile(filePath);
            });
            
            log(`🎵 Added ${audioFiles.length} file(s) from folder to playlist`);

            this._buildPlaylistItems();
            
        } catch (e) {
            log('Error scanning folder: ' + e.message);
        }
    }

    _clearPlaylist() {
        // Potvrda korisniku
        let cmd = [
            'zenity',
            '--question',
            '--title=Clear Playlist',
            '--text=Are you sure you want to clear the entire playlist?\n\nThis action cannot be undone.',
            '--width=400'
        ];
        
        try {
            let proc = Gio.Subprocess.new(
                cmd,
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
            );
            
            proc.communicate_utf8_async(null, null, (proc, res) => {
                try {
                    proc.communicate_utf8_finish(res);
                    
                    if (proc.get_successful()) {
                        // Korisnik je potvrdio - brišemo playlistu GLEDANOG taba
                        log('🎵 Clearing viewed tab playlist');
                        
                        // Zaustavi samo ako gledani tab je onaj koji svira
                        if (this.musicPlayer.activeTab === this.musicPlayer.playingTab) {
                            this.musicPlayer.stop();
                            this.musicPlayer.currentTrack = 0;
                        }
                        
                        // Isprazni GLEDANI tab
                        this.musicPlayer.viewTracks = [];
                        
                        // Spremi
                        this.musicPlayer.savePlaylist();
                        
                        // Update shuffled playlist
                        this.musicPlayer._updateShuffledPlaylist();
                        
                        // Osvježi prikaz playliste
                        this._buildPlaylistItems();
                        
                        // Osvježi prikaz trenutne pjesme
                        this._updateTrackLabel();
                        
                        log('🎵 Playlist cleared');
                        
                        // Prikaži obavijest
                        let notifyCmd = [
                            'notify-send',
                            '-i', 'audio-x-generic',
                            '-t', '3000',
                            'Playlist cleared',
                            'All songs have been removed from the playlist.'
                        ];
                        Gio.Subprocess.new(notifyCmd, Gio.SubprocessFlags.NONE);
                    }
                } catch (e) {
                    log('Error in confirmation dialog: ' + e.message);
                }
            });
            
        } catch (e) {
            log('Error opening confirmation dialog: ' + e.message);
        }
    }
    
    _updateProgress() {
        let progress = this.musicPlayer.getProgress();
        
        let posStr = this._formatTime(progress.position);
        let durStr = this._formatTime(progress.duration);
        this._progressLabel.text = `${posStr} / ${durStr}`;
        
        this._updateTrackLabel();
        this._progressBar.queue_repaint();
    }
    
    _formatTime(seconds) {
        if (!seconds || isNaN(seconds)) return '00:00';
        
        let mins = Math.floor(seconds / 60);
        let secs = Math.floor(seconds % 60);
        return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    
    _drawProgressBar(area) {
        let cr = area.get_context();
        let [width, height] = area.get_surface_size();
        
        let progress = this.musicPlayer.getProgress();
        let fillWidth = (width * progress.percentage) / 100;
        
        let radius = height / 2;
        
        // Background track
        cr.setSourceRGB(0.2, 0.2, 0.2);
        cr.newSubPath();
        cr.arc(radius, radius, radius, Math.PI / 2, 3 * Math.PI / 2);
        cr.arc(width - radius, radius, radius, 3 * Math.PI / 2, Math.PI / 2);
        cr.closePath();
        cr.fill();
        
        // Progress fill (WinAMP orange style)
        if (fillWidth > radius * 2) {
            cr.setSourceRGB(1.0, 0.53, 0.0); // #FF8800 orange
            cr.newSubPath();
            cr.arc(radius, radius, radius, Math.PI / 2, 3 * Math.PI / 2);
            cr.arc(Math.min(fillWidth, width) - radius, radius, radius, 3 * Math.PI / 2, Math.PI / 2);
            cr.closePath();
            cr.fill();
        } else if (fillWidth > 0) {
            cr.setSourceRGB(1.0, 0.53, 0.0);
            cr.arc(radius, radius, radius, 0, 2 * Math.PI);
            cr.fill();
        }
    }
    
    _updateTrackLabel() {
        let trackName = this.musicPlayer.getCurrentTrackName();
        this._trackLabel.label.text = `♪ ${trackName}`;
    }
    
    destroy() {
        if (this._progressUpdateId) {
            GLib.source_remove(this._progressUpdateId);
            this._progressUpdateId = null;
        }
        
        // Disconnect svi signali registrirani s connectObject
        [
            this._playButton, this._stopButton, this._muteButton,
            this._loopButton, this._shuffleButton, this._progressBar,
            this.menu
        ].forEach(obj => { if (obj) obj.disconnectObject(this); });
        
        super.destroy();
    }
});

// ============================================================================
// MAIN EXTENSION CLASS
// ============================================================================
export default class MusicAMPExtension extends Extension {
    enable() {
        log('🎵 Enabling MusicAMP extension');
        
        this._settings = this.getSettings();
        this._player = new MusicPlayer(this.path, this._settings);
        this._indicator = new MusicIndicator(this._player);
        
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }
    
    disable() {
        log('🎵 Disabling MusicAMP extension');
        
        this._indicator?.destroy();
        this._player?.destroy();
        
        this._indicator = null;
        this._player = null;
        this._settings = null;
    }
}