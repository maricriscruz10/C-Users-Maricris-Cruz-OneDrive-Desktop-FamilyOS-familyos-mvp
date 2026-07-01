import React, { useEffect, useState, useCallback } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, SafeAreaView } from 'react-native';
import { StatusBar } from 'expo-status-bar';

import LoginScreen from './src/screens/LoginScreen';
import AgendaScreen from './src/screens/AgendaScreen';
import MembersScreen from './src/screens/MembersScreen';
import NotificationsScreen from './src/screens/NotificationsScreen';
import SettingsScreen from './src/screens/SettingsScreen';
import EventFormModal from './src/screens/EventFormModal';
import BudgetScreen from './src/screens/BudgetScreen';
import MealsScreen from './src/screens/MealsScreen';
import ChoresScreen from './src/screens/ChoresScreen';

import { Api, onConnectivityChange, getOnline, startConnectivityPolling } from './src/api';
import { Cache } from './src/storage';
import { colors } from './src/theme';
import { registerForPushNotifications } from './src/notifications';

// Budget is financially sensitive — hidden entirely for the Child role, mirroring
// the same `!isChild` guard used in the web app's sidebar. Meals and Chores are
// visible to every role (kids need to see their own chores and the family menu).
const ALL_TABS = [
  { key: 'agenda', label: 'Agenda', icon: '📅' },
  { key: 'family', label: 'Family', icon: '👨‍👩‍👧' },
  { key: 'budget', label: 'Budget', icon: '💰', hideForChild: true },
  { key: 'meals', label: 'Meals', icon: '🍽️' },
  { key: 'chores', label: 'Chores', icon: '✅' },
  { key: 'notifications', label: 'Alerts', icon: '🔔' },
  { key: 'settings', label: 'Settings', icon: '⚙️' },
];

export default function App() {
  const [user, setUser] = useState(null);
  const [family, setFamily] = useState(null);
  const [members, setMembers] = useState([]);
  const [tab, setTab] = useState('agenda');
  const [online, setOnline] = useState(true);
  const [modal, setModal] = useState({ open: false, event: null });
  const [bootstrapped, setBootstrapped] = useState(false);

  // try restoring a previous session from cache (so the app survives restarts, like a real app would)
  useEffect(() => {
    (async () => {
      const token = await Cache.getToken();
      if (token) {
        try {
          const me = await Api.me();
          setUser(me.user);
        } catch {
          // token invalid/expired — fall through to login
        }
      }
      setBootstrapped(true);
    })();
  }, []);

  useEffect(() => {
    if (!user) return;
    (async () => {
      const famRes = await Api.family(user.familyId).catch(async () => ({ family: await Cache.getFamily() }));
      setFamily(famRes.family);
      await Cache.setFamily(famRes.family);
      const memRes = await Api.members(user.familyId).catch(async () => ({ members: await Cache.getMembers() }));
      setMembers(memRes.members);
      await Cache.setMembers(memRes.members);
      await registerForPushNotifications().catch(() => {});
    })();
    const unsub = onConnectivityChange(setOnline);
    setOnline(getOnline());
    const pollId = startConnectivityPolling(10000);
    return () => { unsub(); clearInterval(pollId); };
  }, [user]);

  const handleLoggedIn = useCallback((u) => setUser(u), []);
  const handleLogout = useCallback(() => { setUser(null); setFamily(null); setMembers([]); setTab('agenda'); }, []);
  const refreshMembers = useCallback(async () => {
    if (!user) return;
    try {
      const res = await Api.members(user.familyId);
      setMembers(res.members);
      await Cache.setMembers(res.members);
      const me = res.members.find((m) => m.id === user.id);
      if (me) setUser((u) => ({ ...u, name: me.name }));
    } catch {}
  }, [user]);

  if (!bootstrapped) return <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }} />;
  if (!user) return <LoginScreen onLoggedIn={handleLoggedIn} />;

  const isChild = user.role === 'child';
  const tabs = ALL_TABS.filter((t) => !(t.hideForChild && isChild));
  const activeTab = tabs.find((t) => t.key === tab) ? tab : 'agenda';

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }}>
      <StatusBar style="dark" />
      {!online && (
        <View style={styles.offlineBanner}>
          <Text style={styles.offlineText}>⚠ Offline — changes will sync automatically when you reconnect</Text>
        </View>
      )}

      {activeTab === 'agenda' && (
        <AgendaScreen
          user={user} family={family}
          onAddEvent={() => setModal({ open: true, event: null })}
          onOpenEvent={(e) => setModal({ open: true, event: e })}
        />
      )}
      {activeTab === 'family' && <MembersScreen family={family} members={members} user={user} familyId={user.familyId} onMembersChanged={refreshMembers} />}
      {activeTab === 'budget' && !isChild && <BudgetScreen user={user} familyId={user.familyId} />}
      {activeTab === 'meals' && <MealsScreen user={user} familyId={user.familyId} members={members} />}
      {activeTab === 'chores' && <ChoresScreen user={user} familyId={user.familyId} members={members} />}
      {activeTab === 'notifications' && <NotificationsScreen />}
      {activeTab === 'settings' && <SettingsScreen user={user} family={family} onLogout={handleLogout} />}

      <View style={styles.tabBar}>
        {tabs.map((t) => (
          <TouchableOpacity key={t.key} style={styles.tabItem} onPress={() => setTab(t.key)}>
            <Text style={{ fontSize: 18 }}>{t.icon}</Text>
            <Text style={[styles.tabLabel, activeTab === t.key && { color: colors.primary, fontWeight: '700' }]}>{t.label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <EventFormModal
        visible={modal.open}
        existing={modal.event}
        members={members}
        familyId={user.familyId}
        onClose={() => setModal({ open: false, event: null })}
        onSaved={() => setModal({ open: false, event: null })}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  offlineBanner: { backgroundColor: '#fef3c7', padding: 8, alignItems: 'center' },
  offlineText: { fontSize: 12, color: '#92400e', fontWeight: '600' },
  tabBar: { flexDirection: 'row', borderTopWidth: 1, borderColor: colors.border, backgroundColor: colors.card, paddingVertical: 8, paddingBottom: 16 },
  tabItem: { flex: 1, alignItems: 'center', gap: 2 },
  tabLabel: { fontSize: 11, color: colors.muted },
});
