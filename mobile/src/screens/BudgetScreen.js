import React, { useEffect, useState, useCallback } from 'react';
import { View, Text, FlatList, TouchableOpacity, StyleSheet, RefreshControl, Modal,
  TextInput, ScrollView, Alert, Image } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { Api } from '../api';
import { colors } from '../theme';

const PM_OPTIONS = [
  { key: 'cash',        label: 'Cash',   icon: '💵' },
  { key: 'credit_card', label: 'Credit', icon: '💳' },
  { key: 'debit_card',  label: 'Debit',  icon: '🏦' },
  { key: 'gcash',       label: 'GCash',  icon: '📱' },
];
const pmIcon  = Object.fromEntries(PM_OPTIONS.map((p) => [p.key, p.icon]));
const pmLabel = Object.fromEntries(PM_OPTIONS.map((p) => [p.key, p.label]));

export default function BudgetScreen({ user, familyId }) {
  const [summary, setSummary] = useState(null);
  const [categories, setCategories] = useState([]);
  const [transactions, setTransactions] = useState([]);
  const [refreshing, setRefreshing] = useState(false);
  const [txModalOpen, setTxModalOpen] = useState(false);
  const [receiptPreview, setReceiptPreview] = useState(null);

  const load = useCallback(async () => {
    try {
      const [sumRes, catRes, txRes] = await Promise.all([
        Api.budgetSummary(familyId),
        Api.budgetCategories(familyId),
        Api.budgetTransactions(familyId),
      ]);
      setSummary(sumRes);
      setCategories(catRes.categories);
      setTransactions(txRes.transactions);
    } catch (e) {
      Alert.alert('Could not load budget', e.message);
    }
  }, [familyId]);

  useEffect(() => { load(); }, [load]);
  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  const catName = (id) => (categories.find((c) => c.id === id) || {}).name || '—';

  // Payment method breakdown
  const pmTotals = {};
  transactions.forEach((t) => {
    const pm = t.paymentMethod || 'cash';
    pmTotals[pm] = (pmTotals[pm] || 0) + t.amount;
  });

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <View style={styles.header}>
        <View>
          <Text style={styles.title}>Budget</Text>
          <Text style={styles.subtitle}>{summary ? `${summary.month} · $${summary.totalSpent.toFixed(2)} of $${summary.totalLimit.toFixed(2)}` : ''}</Text>
        </View>
        <TouchableOpacity style={styles.addBtn} onPress={() => setTxModalOpen(true)}>
          <Text style={styles.addBtnText}>+ Log</Text>
        </TouchableOpacity>
      </View>
      <FlatList
        data={transactions}
        keyExtractor={(t) => t.id}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        contentContainerStyle={{ padding: 16 }}
        ListHeaderComponent={
          <View style={{ marginBottom: 12 }}>
            {(summary?.categories || []).map((c) => (
              <View key={c.id} style={[styles.catCard, { borderLeftColor: c.color }]}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.catName}>{c.name}</Text>
                  <Text style={styles.catMeta}>limit ${c.monthlyLimit.toFixed(2)}</Text>
                </View>
                <Text style={[styles.catSpent, c.overBudget && { color: colors.red }]}>${c.spent.toFixed(2)}</Text>
              </View>
            ))}

            {Object.keys(pmTotals).length > 0 && (
              <View style={styles.pmSection}>
                <Text style={styles.sectionLabel}>By payment method</Text>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                  {Object.entries(pmTotals).map(([pm, total]) => (
                    <View key={pm} style={styles.pmCard}>
                      <Text style={styles.pmCardIcon}>{pmIcon[pm] || '💳'}</Text>
                      <View>
                        <Text style={styles.pmCardAmount}>${total.toFixed(2)}</Text>
                        <Text style={styles.pmCardLabel}>{pmLabel[pm] || pm}</Text>
                      </View>
                    </View>
                  ))}
                </View>
              </View>
            )}

            <Text style={styles.sectionLabel}>Transactions</Text>
          </View>
        }
        ListEmptyComponent={<Text style={styles.empty}>No transactions logged yet.</Text>}
        renderItem={({ item: t }) => (
          <TouchableOpacity
            style={styles.txRow}
            onPress={t.receiptImage ? () => setReceiptPreview(t.receiptImage) : undefined}
            activeOpacity={t.receiptImage ? 0.7 : 1}
          >
            <View style={{ flex: 1 }}>
              <Text style={styles.txDesc}>{t.description || catName(t.categoryId)}</Text>
              <Text style={styles.txMeta}>{catName(t.categoryId)} · {t.occurredOn}</Text>
              <Text style={styles.txPm}>{pmIcon[t.paymentMethod] || '💵'} {pmLabel[t.paymentMethod] || 'Cash'}</Text>
            </View>
            <View style={{ alignItems: 'flex-end', gap: 4 }}>
              <Text style={styles.txAmount}>${t.amount.toFixed(2)}</Text>
              {t.receiptImage && <Text style={{ fontSize: 11, color: colors.primary }}>🧾 receipt</Text>}
            </View>
          </TouchableOpacity>
        )}
      />

      {/* Receipt lightbox */}
      <Modal visible={!!receiptPreview} transparent animationType="fade" onRequestClose={() => setReceiptPreview(null)}>
        <View style={styles.lightboxBackdrop}>
          <TouchableOpacity style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }} onPress={() => setReceiptPreview(null)}>
            {receiptPreview && <Image source={{ uri: receiptPreview }} style={styles.lightboxImg} resizeMode="contain" />}
            <Text style={{ color: 'white', marginTop: 16, fontSize: 13 }}>Tap to close</Text>
          </TouchableOpacity>
        </View>
      </Modal>

      <TxModal visible={txModalOpen} categories={categories} familyId={familyId}
        onClose={() => setTxModalOpen(false)} onSaved={() => { setTxModalOpen(false); load(); }} />
    </View>
  );
}

function TxModal({ visible, categories, familyId, onClose, onSaved }) {
  const [categoryId, setCategoryId] = useState(categories[0]?.id || '');
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [paymentMethod, setPaymentMethod] = useState('cash');
  const [receiptImage, setReceiptImage] = useState(null);

  useEffect(() => { if (categories.length && !categoryId) setCategoryId(categories[0].id); }, [categories]);

  const pickReceipt = async () => {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) {
      // fall back to gallery if camera denied
      const galleryPerm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!galleryPerm.granted) { Alert.alert('Permission needed', 'Allow camera or photo library access to attach receipts.'); return; }
      const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, quality: 0.6, base64: true, allowsEditing: true });
      if (!result.canceled && result.assets[0].base64) setReceiptImage(`data:image/jpeg;base64,${result.assets[0].base64}`);
      return;
    }
    const result = await ImagePicker.launchCameraAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, quality: 0.6, base64: true, allowsEditing: true });
    if (!result.canceled && result.assets[0].base64) setReceiptImage(`data:image/jpeg;base64,${result.assets[0].base64}`);
  };

  const save = async () => {
    if (!categoryId) return Alert.alert('No budget category exists yet — create one from the desktop app first.');
    const amt = Number(amount);
    if (!amt) return Alert.alert('Enter an amount');
    try {
      await Api.createBudgetTransaction(familyId, { categoryId, amount: amt, description, occurredOn: new Date().toISOString().slice(0, 10), paymentMethod, receiptImage });
      setAmount(''); setDescription(''); setPaymentMethod('cash'); setReceiptImage(null);
      onSaved();
    } catch (e) {
      Alert.alert('Error', e.message);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <ScrollView style={{ flex: 1, backgroundColor: colors.bg }} contentContainerStyle={{ padding: 20, paddingTop: 56 }}>
        <Text style={styles.heading}>Log a transaction</Text>

        <Text style={styles.label}>Category</Text>
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
          {categories.map((c) => (
            <TouchableOpacity key={c.id} onPress={() => setCategoryId(c.id)} style={[styles.pill, categoryId === c.id && styles.pillActive]}>
              <Text style={[styles.pillText, categoryId === c.id && styles.pillTextActive]}>{c.name}</Text>
            </TouchableOpacity>
          ))}
        </View>

        <Text style={styles.label}>Amount ($)</Text>
        <TextInput style={styles.input} value={amount} onChangeText={setAmount} keyboardType="decimal-pad" placeholder="0.00" />

        <Text style={styles.label}>Description</Text>
        <TextInput style={styles.input} value={description} onChangeText={setDescription} placeholder="e.g. Grocery run" />

        <Text style={styles.label}>Payment method</Text>
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
          {PM_OPTIONS.map((p) => (
            <TouchableOpacity key={p.key} onPress={() => setPaymentMethod(p.key)} style={[styles.pill, paymentMethod === p.key && styles.pillActive]}>
              <Text style={[styles.pillText, paymentMethod === p.key && styles.pillTextActive]}>{p.icon} {p.label}</Text>
            </TouchableOpacity>
          ))}
        </View>

        <Text style={styles.label}>Receipt (optional)</Text>
        {receiptImage ? (
          <View style={{ marginBottom: 12 }}>
            <Image source={{ uri: receiptImage }} style={{ width: '100%', height: 160, borderRadius: 10, marginBottom: 8 }} resizeMode="cover" />
            <TouchableOpacity onPress={() => setReceiptImage(null)} style={[styles.pill, { alignSelf: 'flex-start' }]}>
              <Text style={styles.pillText}>✕ Remove</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <TouchableOpacity style={[styles.btn, { backgroundColor: colors.border, marginBottom: 12 }]} onPress={pickReceipt}>
            <Text style={[styles.btnText, { color: colors.text }]}>📷 Scan / attach receipt</Text>
          </TouchableOpacity>
        )}

        <View style={{ flexDirection: 'row', gap: 10, marginTop: 8 }}>
          <TouchableOpacity style={[styles.btn, { backgroundColor: colors.border, flex: 0 }]} onPress={onClose}>
            <Text style={[styles.btnText, { color: colors.text }]}>Cancel</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.btn, { backgroundColor: colors.primary, flex: 1 }]} onPress={save}>
            <Text style={styles.btnText}>Save</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 16, paddingTop: 56, backgroundColor: colors.card, borderBottomWidth: 1, borderColor: colors.border },
  title: { fontSize: 20, fontWeight: '800', color: colors.text },
  subtitle: { fontSize: 12, color: colors.muted },
  addBtn: { backgroundColor: colors.primary, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 10 },
  addBtnText: { color: 'white', fontWeight: '700', fontSize: 13 },
  catCard: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.card, borderRadius: 12, padding: 12, marginBottom: 8, borderWidth: 1, borderColor: colors.border, borderLeftWidth: 4 },
  catName: { fontWeight: '700', fontSize: 13, color: colors.text },
  catMeta: { fontSize: 11, color: colors.muted },
  catSpent: { fontWeight: '800', fontSize: 15, color: colors.text },
  pmSection: { marginVertical: 8 },
  pmCard: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: colors.card, borderRadius: 10, padding: 10, borderWidth: 1, borderColor: colors.border },
  pmCardIcon: { fontSize: 20 },
  pmCardAmount: { fontWeight: '800', fontSize: 14, color: colors.text },
  pmCardLabel: { fontSize: 11, color: colors.muted },
  sectionLabel: { fontSize: 12, fontWeight: '700', color: colors.muted, textTransform: 'uppercase', marginTop: 8, marginBottom: 4 },
  txRow: { flexDirection: 'row', backgroundColor: colors.card, borderRadius: 12, padding: 12, marginBottom: 8, borderWidth: 1, borderColor: colors.border },
  txDesc: { fontWeight: '700', fontSize: 13, color: colors.text },
  txMeta: { fontSize: 11, color: colors.muted, marginTop: 1 },
  txPm: { fontSize: 11, color: colors.muted, marginTop: 2 },
  txAmount: { fontWeight: '800', fontSize: 14, color: colors.text },
  empty: { textAlign: 'center', color: colors.muted, marginTop: 40 },
  heading: { fontSize: 20, fontWeight: '800', marginBottom: 16 },
  label: { fontSize: 12, fontWeight: '700', color: colors.muted, marginBottom: 6, marginTop: 10 },
  input: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: 10, padding: 10, fontSize: 14 },
  pill: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border },
  pillActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  pillText: { fontSize: 12, color: colors.text },
  pillTextActive: { color: 'white', fontWeight: '700' },
  btn: { paddingVertical: 12, borderRadius: 10, alignItems: 'center', paddingHorizontal: 16 },
  btnText: { color: 'white', fontWeight: '700' },
  lightboxBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.88)', padding: 20 },
  lightboxImg: { width: '100%', height: '75%', borderRadius: 12 },
});
