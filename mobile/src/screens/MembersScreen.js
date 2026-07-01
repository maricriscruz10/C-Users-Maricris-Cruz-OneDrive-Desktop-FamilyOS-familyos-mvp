import React, { useState } from 'react';
import { View, Text, FlatList, TouchableOpacity, StyleSheet, Modal, TextInput, Alert } from 'react-native';
import { Api } from '../api';
import { colors, initials, roleBadgeColor } from '../theme';

export default function MembersScreen({ family, members, user, familyId, onMembersChanged }) {
  const [editTarget, setEditTarget] = useState(null); // { id, name }
  const [editName, setEditName] = useState('');
  const [saving, setSaving] = useState(false);

  const isAdmin = user?.role === 'admin';

  const openEdit = (m) => { setEditTarget(m); setEditName(m.name); };
  const closeEdit = () => { setEditTarget(null); setEditName(''); };

  const saveName = async () => {
    if (!editName.trim()) return Alert.alert('Name cannot be empty');
    if (editName.trim() === editTarget.name) { closeEdit(); return; }
    setSaving(true);
    try {
      await Api.updateMember(familyId, editTarget.id, { name: editName.trim() });
      onMembersChanged?.();
      closeEdit();
    } catch (e) {
      Alert.alert('Error', e.message);
    } finally {
      setSaving(false);
    }
  };

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
          const canEdit = isAdmin || m.id === user?.id;
          return (
            <View style={styles.row}>
              <View style={[styles.avatar, { backgroundColor: m.avatarColor }]}>
                <Text style={styles.avatarText}>{initials(m.name)}</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.name}>{m.name}</Text>
                <Text style={styles.email}>{m.email}</Text>
              </View>
              <View style={[styles.badge, { backgroundColor: badge.bg, marginRight: 8 }]}>
                <Text style={[styles.badgeText, { color: badge.text }]}>{m.role}</Text>
              </View>
              {canEdit && (
                <TouchableOpacity onPress={() => openEdit(m)} style={styles.editBtn}>
                  <Text style={styles.editBtnText}>✏️</Text>
                </TouchableOpacity>
              )}
            </View>
          );
        }}
      />

      <Text style={styles.note}>Role changes & invites are managed from the desktop app.</Text>

      {/* Edit name modal */}
      <Modal visible={!!editTarget} animationType="fade" transparent onRequestClose={closeEdit}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modalBox}>
            <Text style={styles.modalTitle}>Edit name</Text>
            <TextInput
              style={styles.input}
              value={editName}
              onChangeText={setEditName}
              autoFocus
              selectTextOnFocus
              onSubmitEditing={saveName}
              returnKeyType="done"
            />
            <View style={{ flexDirection: 'row', gap: 10, marginTop: 16 }}>
              <TouchableOpacity style={[styles.btn, { backgroundColor: colors.border, flex: 0, paddingHorizontal: 20 }]} onPress={closeEdit}>
                <Text style={[styles.btnText, { color: colors.text }]}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.btn, { backgroundColor: colors.primary, flex: 1 }]} onPress={saveName} disabled={saving}>
                <Text style={styles.btnText}>{saving ? 'Saving…' : 'Save'}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
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
  editBtn: { padding: 6 },
  editBtnText: { fontSize: 16 },
  note: { fontSize: 11, color: colors.muted, padding: 16, textAlign: 'center' },
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(20,20,40,0.45)', alignItems: 'center', justifyContent: 'center', padding: 24 },
  modalBox: { backgroundColor: colors.card, borderRadius: 16, padding: 24, width: '100%', shadowColor: '#000', shadowOpacity: 0.18, shadowRadius: 12, elevation: 8 },
  modalTitle: { fontSize: 17, fontWeight: '800', color: colors.text, marginBottom: 14 },
  input: { backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border, borderRadius: 10, padding: 12, fontSize: 15, color: colors.text },
  btn: { paddingVertical: 12, borderRadius: 10, alignItems: 'center' },
  btnText: { color: 'white', fontWeight: '700', fontSize: 14 },
});
