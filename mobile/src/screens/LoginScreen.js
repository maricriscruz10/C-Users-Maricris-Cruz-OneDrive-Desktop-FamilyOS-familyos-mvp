import React, { useEffect, useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native';
import { Api } from '../api';
import { Cache } from '../storage';
import { colors, initials, roleBadgeColor } from '../theme';

export default function LoginScreen({ onLoggedIn }) {
  const [users, setUsers] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    Api.devUsers().then((r) => setUsers(r.users)).catch((e) => setError(e.message));
  }, []);

  const handlePick = async (u) => {
    try {
      const r = await Api.login(u.id);
      await Cache.setToken(r.token);
      onLoggedIn(r.user);
    } catch (e) {
      setError(e.message);
    }
  };

  const byFamily = {};
  (users || []).forEach((u) => { (byFamily[u.familyName] ||= []).push(u); });

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.bg }} contentContainerStyle={{ padding: 20, paddingTop: 60 }}>
      <Text style={styles.brand}>● FamilyOS</Text>
      <Text style={styles.subtitle}>Dev Login — pick a household member to test as.{'\n'}
        Production uses Google/Apple OAuth only (see docs for why this dev-mode picker exists).</Text>
      {error && <Text style={{ color: colors.red, marginBottom: 12 }}>{error} — is the backend reachable at the address in src/config.js?</Text>}
      {!users && !error && <ActivityIndicator />}
      {Object.entries(byFamily).map(([fam, list]) => (
        <View key={fam} style={{ marginBottom: 18 }}>
          <Text style={styles.familyLabel}>{fam}</Text>
          {list.map((u) => {
            const badge = roleBadgeColor(u.role);
            return (
              <TouchableOpacity key={u.id} style={styles.userRow} onPress={() => handlePick(u)}>
                <View style={[styles.avatar, { backgroundColor: u.avatarColor }]}>
                  <Text style={styles.avatarText}>{initials(u.name)}</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.userName}>{u.name}</Text>
                  <Text style={styles.userEmail}>{u.email}{u.status === 'invited' ? ' · invited' : ''}</Text>
                </View>
                <View style={[styles.badge, { backgroundColor: badge.bg }]}>
                  <Text style={[styles.badgeText, { color: badge.text }]}>{u.role}</Text>
                </View>
              </TouchableOpacity>
            );
          })}
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  brand: { fontSize: 24, fontWeight: '800', color: colors.primary, marginBottom: 8 },
  subtitle: { color: colors.muted, marginBottom: 24, fontSize: 13, lineHeight: 18 },
  familyLabel: { fontSize: 12, fontWeight: '700', color: colors.muted, textTransform: 'uppercase', marginBottom: 8, letterSpacing: 0.5 },
  userRow: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: colors.card, borderRadius: 14, padding: 12, marginBottom: 8, borderWidth: 1, borderColor: colors.border },
  avatar: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: 'white', fontWeight: '700' },
  userName: { fontWeight: '700', fontSize: 14, color: colors.text },
  userEmail: { fontSize: 12, color: colors.muted },
  badge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999 },
  badgeText: { fontSize: 10, fontWeight: '800', textTransform: 'uppercase' },
});
