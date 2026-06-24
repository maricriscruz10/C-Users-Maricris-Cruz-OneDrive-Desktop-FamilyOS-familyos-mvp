import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Alert } from 'react-native';
import { colors, initials } from '../theme';
import { Cache } from '../storage';
import { API_BASE } from '../config';

export default function SettingsScreen({ user, family, onLogout }) {
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <View style={styles.header}><Text style={styles.title}>Settings</Text></View>
      <View style={{ padding: 16 }}>
        <View style={styles.card}>
          <View style={styles.row}>
            <View style={[styles.avatar, { backgroundColor: user.avatarColor }]}><Text style={styles.avatarText}>{initials(user.name)}</Text></View>
            <View>
              <Text style={styles.name}>{user.name}</Text>
              <Text style={styles.muted}>{user.email} · {user.role}</Text>
            </View>
          </View>
        </View>
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Household</Text>
          <Text style={styles.muted}>{family?.name}</Text>
          <Text style={styles.muted}>Timezone: {family?.timezone}</Text>
        </View>
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Connection</Text>
          <Text style={styles.muted}>Backend: {API_BASE}</Text>
          <Text style={styles.mutedSmall}>If you can't connect, change src/config.js to your computer's LAN IP — "localhost" won't reach your computer from a phone.</Text>
        </View>
        <TouchableOpacity
          style={styles.logoutBtn}
          onPress={() => Alert.alert('Switch user?', 'You will be logged out.', [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Switch user', style: 'destructive', onPress: async () => { await Cache.clearAll(); onLogout(); } },
          ])}
        >
          <Text style={styles.logoutText}>Switch user / Log out</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  header: { padding: 16, paddingTop: 56, backgroundColor: colors.card, borderBottomWidth: 1, borderColor: colors.border },
  title: { fontSize: 20, fontWeight: '800', color: colors.text },
  card: { backgroundColor: colors.card, borderRadius: 12, padding: 14, marginBottom: 12, borderWidth: 1, borderColor: colors.border },
  cardTitle: { fontWeight: '700', marginBottom: 6 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  avatar: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: 'white', fontWeight: '700' },
  name: { fontWeight: '700', fontSize: 15 },
  muted: { color: colors.muted, fontSize: 13 },
  mutedSmall: { color: colors.muted, fontSize: 11, marginTop: 6 },
  logoutBtn: { backgroundColor: colors.red, padding: 14, borderRadius: 12, alignItems: 'center', marginTop: 8 },
  logoutText: { color: 'white', fontWeight: '700' },
});
