import React, { useEffect, useState } from 'react';
import { View, Text, FlatList, StyleSheet, TouchableOpacity } from 'react-native';
import { Api } from '../api';
import { Cache } from '../storage';
import { colors } from '../theme';

export default function NotificationsScreen() {
  const [items, setItems] = useState([]);

  const load = async () => {
    try {
      const r = await Api.notifications();
      setItems(r.notifications);
      await Cache.setNotifications(r.notifications);
    } catch {
      setItems(await Cache.getNotifications());
    }
  };
  useEffect(() => { load(); }, []);

  const markRead = async (n) => {
    setItems((prev) => prev.map((x) => (x.id === n.id ? { ...x, read: true } : x)));
    try { await Api.markNotificationRead(n.id); } catch {}
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <View style={styles.header}><Text style={styles.title}>Notifications</Text></View>
      <FlatList
        data={items}
        keyExtractor={(n) => n.id}
        contentContainerStyle={{ padding: 16 }}
        ListEmptyComponent={<Text style={{ textAlign: 'center', color: colors.muted, marginTop: 40 }}>No notifications yet.</Text>}
        renderItem={({ item: n }) => (
          <TouchableOpacity style={[styles.row, !n.read && styles.unread]} onPress={() => markRead(n)}>
            <View style={[styles.dot, { backgroundColor: n.read ? 'transparent' : colors.primary }]} />
            <View style={{ flex: 1 }}>
              <Text style={styles.notifTitle}>{n.title}</Text>
              <Text style={styles.notifBody}>{n.body}</Text>
            </View>
          </TouchableOpacity>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  header: { padding: 16, paddingTop: 56, backgroundColor: colors.card, borderBottomWidth: 1, borderColor: colors.border },
  title: { fontSize: 20, fontWeight: '800', color: colors.text },
  row: { flexDirection: 'row', gap: 10, backgroundColor: colors.card, borderRadius: 12, padding: 12, marginBottom: 8, borderWidth: 1, borderColor: colors.border, alignItems: 'flex-start' },
  unread: { backgroundColor: '#f5f5ff' },
  dot: { width: 8, height: 8, borderRadius: 4, marginTop: 4 },
  notifTitle: { fontWeight: '700', fontSize: 13 },
  notifBody: { fontSize: 12, color: colors.muted, marginTop: 2 },
});
