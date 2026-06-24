import React from 'react';
import { View, Text, FlatList, StyleSheet } from 'react-native';
import { colors, initials, roleBadgeColor } from '../theme';

export default function MembersScreen({ family, members }) {
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <View style={styles.header}>
        <Text style={styles.title}>Family</Text>
        <Text style={styles.subtitle}>{family?.name} · {members.length} members</Text>
      </View>
      <FlatList
        data={members}
        keyExtractor={(m) => m.id}
        contentContainerStyle={{ padding: 16 }}
        renderItem={({ item: m }) => {
          const badge = roleBadgeColor(m.role);
          return (
            <View style={styles.row}>
              <View style={[styles.avatar, { backgroundColor: m.avatarColor }]}><Text style={styles.avatarText}>{initials(m.name)}</Text></View>
              <View style={{ flex: 1 }}>
                <Text style={styles.name}>{m.name}</Text>
                <Text style={styles.email}>{m.email}</Text>
              </View>
              <View style={[styles.badge, { backgroundColor: badge.bg }]}><Text style={[styles.badgeText, { color: badge.text }]}>{m.role}</Text></View>
            </View>
          );
        }}
      />
      <Text style={styles.note}>Member invites &amp; role changes are managed from the desktop app for now (full parity is a quick follow-up — see docs).</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  header: { padding: 16, paddingTop: 56, backgroundColor: colors.card, borderBottomWidth: 1, borderColor: colors.border },
  title: { fontSize: 20, fontWeight: '800', color: colors.text },
  subtitle: { fontSize: 12, color: colors.muted },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: colors.card, borderRadius: 12, padding: 12, marginBottom: 8, borderWidth: 1, borderColor: colors.border },
  avatar: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: 'white', fontWeight: '700', fontSize: 12 },
  name: { fontWeight: '700', fontSize: 14 },
  email: { fontSize: 12, color: colors.muted },
  badge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999 },
  badgeText: { fontSize: 10, fontWeight: '800', textTransform: 'uppercase' },
  note: { fontSize: 11, color: colors.muted, padding: 16, textAlign: 'center' },
});
